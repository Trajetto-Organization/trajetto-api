import { env } from "@/env";
import { IWhatsAppProvider } from "../IWhatsApp-provider";

import { SendMessageProps, WhatsAppResponse } from "../dtos";

/**
 * Longest text accepted as the template's body parameter. Meta caps the
 * rendered body at 1024 characters, and the approved template's fixed text
 * also counts toward that — so the variable part is capped below the limit.
 */
const MAX_TEMPLATE_PARAMETER_LENGTH = 900;

/**
 * A send must finish well inside the notification pipeline's own budget.
 *
 * The pipeline wraps every delivery in a 15s backstop
 * (`PER_DELIVERY_TIMEOUT_MS`) and sizes its claim lease around that
 * (`ceil(batch / concurrency) * timeout < lease`). At 30s this request could
 * never time out on its own: the backstop always fired first, so a hung Graph
 * call surfaced as a generic pipeline abort instead of the network failure it
 * was — losing the classification below and, worse, leaving the send in flight
 * while the row was already being reconsidered. 10s fits inside the backstop
 * with room for a healthy Graph round trip, so the provider reports and
 * classifies its own timeouts.
 */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Meta Cloud API error codes that describe a temporary condition: rate limits
 * and failures on Meta's side. The same payload can succeed on a later
 * attempt, so the delivery is worth retrying.
 *
 * Source: WhatsApp Cloud API "Error Codes" reference
 * (developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes).
 */
const RETRYABLE_META_ERROR_CODES = new Set<number>([
  1, // API unknown — undocumented internal failure, in practice transient
  2, // API service temporarily unavailable
  80007, // Business account rate limit hit
  130429, // Cloud API message throughput rate limit hit
  131000, // Generic internal error on Meta's side
  131048, // Spam rate limit hit — sending is throttled, the message is not refused
  131056, // Pair rate limit hit — too many messages between this pair right now
  133016, // Registration/deregistration rate limit hit
]);

/**
 * Codes describing a permanent problem with this exact message: the recipient,
 * the template, the parameters or the account itself. A retry re-sends an
 * identical payload and collects an identical rejection, so the delivery must
 * fail fast instead of consuming the retry budget.
 *
 * Source: WhatsApp Cloud API "Error Codes" reference.
 */
const NON_RETRYABLE_META_ERROR_CODES = new Set<number>([
  100, // Invalid parameter
  131008, // Required parameter is missing
  131009, // Parameter value is not valid
  131026, // Message undeliverable — recipient has no WhatsApp or cannot receive it
  131031, // Business account is locked or restricted
  131047, // Re-engagement message — outside the 24h window, requires a template
  132000, // Template parameter count mismatch
  132001, // Template does not exist for this name/language
  132005, // Template hydrated text is too long
  132007, // Template format character policy violated
  132012, // Template parameter format mismatch
  132015, // Template is paused
  132016, // Template is disabled
]);

/**
 * What the transport layer observed about a failed attempt. `networkError`
 * means fetch itself threw — timeout, DNS, socket — so no HTTP response and no
 * Meta error code ever arrived.
 */
interface MetaErrorSignals {
  httpStatus?: number;
  errorCode?: number;
  networkError?: boolean;
}

interface MetaErrorClassification {
  retryable: boolean;
  /** Short English explanation of which rule decided, for logs and tests. */
  reason: string;
}

interface MetaMessagesResponse {
  messages?: Array<{ id: string }>;
  error?: {
    message: string;
    type?: string;
    code?: number;
    error_data?: { details?: string };
  };
}

/**
 * Decides whether a failed send is worth another attempt.
 *
 * Pure on purpose: the retry decision is the part that must be provable
 * without touching the network.
 */
function classifyMetaError({
  httpStatus,
  errorCode,
  networkError,
}: MetaErrorSignals): MetaErrorClassification {
  // No answer at all says nothing about the message itself.
  if (networkError) {
    return { retryable: true, reason: "network or timeout failure" };
  }

  // Meta's own code is more precise than the HTTP status — throttling, for
  // instance, can arrive as an HTTP 400 — so the tables are consulted first.
  if (errorCode !== undefined) {
    if (NON_RETRYABLE_META_ERROR_CODES.has(errorCode)) {
      return {
        retryable: false,
        reason: `permanent Meta error code ${errorCode}`,
      };
    }

    if (RETRYABLE_META_ERROR_CODES.has(errorCode)) {
      return {
        retryable: true,
        reason: `transient Meta error code ${errorCode}`,
      };
    }
  }

  if (httpStatus === 401 || httpStatus === 403) {
    return {
      retryable: false,
      reason: `invalid or unauthorized credentials (HTTP ${httpStatus})`,
    };
  }

  if (httpStatus === 429) {
    return { retryable: true, reason: "rate limited (HTTP 429)" };
  }

  if (httpStatus !== undefined && httpStatus >= 500) {
    return { retryable: true, reason: `Meta server error (HTTP ${httpStatus})` };
  }

  /**
   * Fallback for codes absent from both tables. A 4xx is Meta refusing this
   * exact payload, and refusing it again is the only thing a retry can
   * achieve, so it is permanent. A 5xx — handled above — and anything with no
   * status at all are treated as transient: that keeps the previous behaviour
   * for genuinely unknown failures and never drops a message a later attempt
   * could still deliver.
   */
  if (httpStatus !== undefined && httpStatus >= 400) {
    return {
      retryable: false,
      reason: `unmapped client error (HTTP ${httpStatus})`,
    };
  }

  return { retryable: true, reason: "unclassified failure" };
}

/**
 * `Retry-After` is defined as either a delay in seconds or an HTTP date. Meta
 * sends the numeric form; anything else is ignored rather than guessed at, and
 * the caller falls back to its own backoff.
 */
function parseRetryAfterSeconds(
  headerValue: string | null,
): number | undefined {
  if (!headerValue) {
    return undefined;
  }

  const seconds = Number(headerValue.trim());

  if (!Number.isFinite(seconds) || seconds < 0) {
    return undefined;
  }

  return Math.ceil(seconds);
}

/**
 * Brazilian E.164 normalization for the `to` field.
 *
 * The decision is made by LENGTH, never by a "55" prefix. Area code 55
 * (Santa Maria/RS) produces local numbers that already begin with "55", so a
 * prefix test reads them as already carrying the country code and ships a
 * truncated, wrong destination. Digit counts, in contrast, are unambiguous
 * inside Brazil:
 *
 *   10 digits — DDD + 8-digit landline        → prepend "55"
 *   11 digits — DDD + 9 + 8-digit mobile      → prepend "55"
 *   12 digits — 55 + DDD + 8-digit landline   → already complete
 *   13 digits — 55 + DDD + 9 + 8-digit mobile → already complete
 *
 * Any other length belongs to another country's numbering plan and is returned
 * exactly as typed — a country code is never invented for it. The known
 * limitation is that a foreign number that happens to be 10 or 11 digits long
 * is indistinguishable from a local Brazilian one; this product only sends to
 * Brazilian recipients, so length wins.
 */
function normalizePhoneNumber(phone: string): string {
  const digits = phone.replace(/\D/g, "");

  if (digits.length === 10 || digits.length === 11) {
    return `55${digits}`;
  }

  return digits;
}

/**
 * Official WhatsApp sender (Meta Cloud API / Graph).
 *
 * Business-initiated messages are only accepted as pre-approved templates —
 * free-form text works solely inside the 24h window after the user writes
 * first, which a notification can never rely on. So every send goes out as
 * the template named by `META_WHATSAPP_TEMPLATE_NAME`, with the notification
 * text as its single body parameter. The template itself is created and
 * approved in Meta Business Manager; see the README for its expected shape.
 */
class MetaCloudApiProvider implements IWhatsAppProvider {
  isConfigured(): boolean {
    return Boolean(
      env.META_WHATSAPP_ACCESS_TOKEN && env.META_WHATSAPP_PHONE_NUMBER_ID,
    );
  }

  async sendMessage({
    phoneNumber,
    message,
  }: SendMessageProps): Promise<WhatsAppResponse> {
    if (!this.isConfigured()) {
      // Missing credentials are a deployment problem, not a transient one:
      // every retry fails identically until an operator sets the variables.
      return {
        success: false,
        retryable: false,
        message:
          "WhatsApp não configurado: defina META_WHATSAPP_ACCESS_TOKEN e META_WHATSAPP_PHONE_NUMBER_ID.",
      };
    }

    const endpoint = `https://graph.facebook.com/${env.META_WHATSAPP_API_VERSION}/${env.META_WHATSAPP_PHONE_NUMBER_ID}/messages`;

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.META_WHATSAPP_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: normalizePhoneNumber(phoneNumber),
          type: "template",
          template: {
            name: env.META_WHATSAPP_TEMPLATE_NAME,
            language: { code: "pt_BR" },
            components: [
              {
                type: "body",
                parameters: [
                  {
                    type: "text",
                    text: this.sanitizeTemplateParameter(message),
                  },
                ],
              },
            ],
          },
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      const payload = (await response
        .json()
        .catch(() => null)) as MetaMessagesResponse | null;

      if (!response.ok) {
        const details = payload?.error?.error_data?.details;
        const errorCode = payload?.error?.code;

        const { retryable } = classifyMetaError({
          httpStatus: response.status,
          errorCode,
        });

        return {
          success: false,
          retryable,
          errorCode,
          httpStatus: response.status,
          // Read on every response, not only on 429: Meta also sends it with
          // some 4xx throttling answers, and an absent header simply yields
          // undefined.
          retryAfterSeconds: parseRetryAfterSeconds(
            response.headers.get("retry-after"),
          ),
          message:
            payload?.error?.message ??
            `Meta Cloud API respondeu HTTP ${response.status}`,
          data: details ? { details } : undefined,
        };
      }

      return {
        success: true,
        retryable: false,
        message: "Mensagem enviada com sucesso",
        httpStatus: response.status,
        messageId: payload?.messages?.[0]?.id,
      };
    } catch (error) {
      // fetch only throws for transport-level problems. The abort raised by
      // AbortSignal.timeout surfaces as "TimeoutError" on Node and as
      // "AbortError" elsewhere; either way no answer arrived, which never
      // means the message was refused.
      const timedOut =
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError");

      const { retryable } = classifyMetaError({ networkError: true });

      if (timedOut) {
        return {
          success: false,
          retryable,
          message: `Meta Cloud API não respondeu em ${REQUEST_TIMEOUT_MS / 1000}s`,
        };
      }

      return {
        success: false,
        retryable,
        message:
          error instanceof Error
            ? `Falha ao chamar a Meta Cloud API: ${error.message}`
            : "Falha ao chamar a Meta Cloud API",
      };
    }
  }

  /**
   * Meta rejects template parameters containing newlines, tabs or runs of
   * four or more spaces, so multi-line notification texts are flattened
   * before going into the body variable.
   */
  private sanitizeTemplateParameter(message: string): string {
    const flattened = message.replace(/\s+/g, " ").trim();

    if (flattened.length <= MAX_TEMPLATE_PARAMETER_LENGTH) {
      return flattened;
    }

    return `${flattened.slice(0, MAX_TEMPLATE_PARAMETER_LENGTH - 1)}…`;
  }
}

export {
  classifyMetaError,
  MetaCloudApiProvider,
  NON_RETRYABLE_META_ERROR_CODES,
  normalizePhoneNumber,
  parseRetryAfterSeconds,
  RETRYABLE_META_ERROR_CODES,
  REQUEST_TIMEOUT_MS,
};

export type { MetaErrorClassification, MetaErrorSignals };
