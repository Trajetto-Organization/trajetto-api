import { createHmac, timingSafeEqual } from "node:crypto";

import { redactEmails } from "@/shared/logging/redact-email";

/**
 * Reading what Resend posts to its webhook (OBS-08). Pure, so the parts that
 * decide whether a body is trusted and which message it is about are proven
 * without a server.
 *
 * Resend signs with Svix (resend.com/docs/webhooks/verify-webhooks-requests,
 * docs.svix.com/receiving/verifying-payloads/how-manual):
 *   signed content = `${svix-id}.${svix-timestamp}.${raw body}`
 *   key            = base64-decode(secret without its `whsec_` prefix)
 *   svix-signature = space-separated `v1,<base64 HMAC-SHA256>` entries
 * More than one entry is a secret being rotated: any of them may match.
 */

/** Svix's own tolerance: a callback older (or newer) than this is a replay. */
const SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;

interface SvixHeaders {
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
}

function signingKey(secret: string): Buffer {
  return Buffer.from(
    secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret,
    "base64",
  );
}

function verifySvixSignature(
  headers: SvixHeaders,
  rawBody: Buffer,
  secret: string,
  now: number = Date.now(),
): boolean {
  const { id, timestamp, signature } = headers;

  if (!id || !timestamp || !signature || !/^\d{1,12}$/.test(timestamp)) {
    return false;
  }

  if (Math.abs(now - Number(timestamp) * 1000) > SIGNATURE_TOLERANCE_MS) {
    return false;
  }

  const expected = createHmac("sha256", signingKey(secret))
    .update(`${id}.${timestamp}.`)
    .update(rawBody)
    .digest();

  return signature.split(" ").some((entry) => {
    const [version, value] = entry.split(",", 2);

    if (version !== "v1" || !value) return false;

    const received = Buffer.from(value, "base64");

    // Buffer.from(base64) drops what is not base64, so a malformed entry
    // comes out short; timingSafeEqual would throw on the length mismatch.
    return (
      received.length === expected.length && timingSafeEqual(received, expected)
    );
  });
}

/**
 * How far along an e-mail is, by Resend's event names (`email.` dropped).
 * providerStatus only ever moves up this ranking. The three ways an e-mail
 * does not arrive share the top rank but one, so the first of them sticks; a
 * complaint comes after delivery (the recipient marked it as spam) and is the
 * last word.
 */
const RESEND_STATUS_RANK: Record<string, number> = {
  sent: 1,
  delivery_delayed: 2,
  delivered: 3,
  bounced: 4,
  failed: 4,
  suppressed: 4,
  complained: 5,
};

/** One event Resend reported about one e-mail. */
interface ResendEventReport {
  /** The event type without its `email.` prefix; a key of RESEND_STATUS_RANK. */
  status: string;

  /** Resend's id for the e-mail. */
  emailId: string;

  /** The RFC Message-ID header of the e-mail, which the pipeline sets. */
  messageId: string | null;

  occurredAt: Date;

  /** For a bounce: `Permanent/General`, `Transient/MailboxFull`... */
  errorCode: string | null;

  errorMessage: string | null;
}

/** Columns are text, but a callback is untrusted input until proven otherwise. */
const MAX_FIELD_LENGTH = 500;

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0
    ? value.slice(0, MAX_FIELD_LENGTH)
    : null;
}

/**
 * The event, or null for anything this receiver does not track (opens,
 * clicks, domains, contacts) or cannot tie to an e-mail. Addresses in the
 * bounce text are masked (OBS-15): the ledger is kept, and the recipient is
 * often a carrier's customer.
 */
function extractResendEvent(body: unknown): ResendEventReport | null {
  if (typeof body !== "object" || body === null) return null;

  const {
    type,
    created_at: createdAt,
    data,
  } = body as {
    type?: unknown;
    created_at?: unknown;
    data?: Record<string, unknown>;
  };

  if (typeof type !== "string" || !type.startsWith("email.")) return null;

  const status = type.slice("email.".length);

  if (!(status in RESEND_STATUS_RANK)) return null;

  const emailId = text(data?.email_id);

  if (!emailId) return null;

  const occurred =
    typeof createdAt === "string" ? new Date(createdAt) : new Date(Number.NaN);

  const bounce = (data?.bounce ?? data?.failed ?? null) as Record<
    string,
    unknown
  > | null;

  const code = bounce
    ? [text(bounce.type), text(bounce.subType)].filter(Boolean).join("/")
    : "";

  const reason = bounce ? (text(bounce.message) ?? text(bounce.reason)) : null;

  return {
    status,
    emailId,
    messageId: text(data?.message_id),
    occurredAt: Number.isNaN(occurred.getTime()) ? new Date() : occurred,
    errorCode: code ? code.slice(0, MAX_FIELD_LENGTH) : null,
    errorMessage: reason ? redactEmails(reason) : null,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The delivery a Message-ID names. ResendMailProvider builds it as
 * `<delivery id@sender domain>` (message-id.ts), and Resend reports that
 * header back as `message_id` — so the delivery is found even when its own
 * providerMessageId write was lost.
 */
function deliveryIdFromMessageId(messageId: string | null): string | null {
  const local = messageId?.match(/^<?([^@<>]+)@/)?.[1];

  return local && UUID.test(local) ? local.toLowerCase() : null;
}

export {
  RESEND_STATUS_RANK,
  deliveryIdFromMessageId,
  extractResendEvent,
  verifySvixSignature,
};
export type { ResendEventReport, SvixHeaders };
