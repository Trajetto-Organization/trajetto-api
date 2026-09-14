/**
 * Every mail failure now reaches the notification pipeline, which needs to
 * know whether a retry can ever succeed: a throttled SMTP server deserves a
 * backed-off retry, an invalid recipient does not. `retryable` carries that
 * decision so the pipeline never burns its retry budget on a permanent error.
 */
class MailDeliveryError extends Error {
  public readonly retryable: boolean;

  /** Nodemailer error code, when the failure came from the transport. */
  public readonly code?: string;

  /** SMTP numeric reply (e.g. 421, 550), when the server answered. */
  public readonly responseCode?: number;

  public readonly cause?: unknown;

  constructor(
    message: string,
    options: {
      retryable: boolean;
      code?: string;
      responseCode?: number;
      cause?: unknown;
    },
  ) {
    super(message);

    this.name = "MailDeliveryError";
    this.retryable = options.retryable;

    this.code = options.code;
    this.responseCode = options.responseCode;

    this.cause = options.cause;
  }
}

/**
 * Transport-level codes: the message never reached a server that could judge
 * it, so the same send can succeed on the next attempt.
 */
const RETRYABLE_TRANSPORT_CODES = new Set([
  "ETIMEDOUT",
  "ETIMEOUT",
  "ECONNECTION",
  "ECONNRESET",
  "ECONNREFUSED",
  "ESOCKET",
  "EDNS",
  "EPROTOCOL",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
]);

/**
 * Configuration/content codes: credentials, sender identity or envelope are
 * wrong. Retrying replays the exact same rejection.
 */
const NON_RETRYABLE_TRANSPORT_CODES = new Set([
  "EAUTH",
  "EENVELOPE",
  "EMESSAGE",
  "ETLS",
]);

interface NodemailerLikeError {
  message?: unknown;
  code?: unknown;
  responseCode?: unknown;
}

function readTransportFields(error: unknown): {
  code?: string;
  responseCode?: number;
} {
  if (typeof error !== "object" || error === null) return {};

  const candidate = error as NodemailerLikeError;

  return {
    code: typeof candidate.code === "string" ? candidate.code : undefined,
    responseCode:
      typeof candidate.responseCode === "number"
        ? candidate.responseCode
        : undefined,
  };
}

/**
 * Turns whatever nodemailer (or the template read) threw into a
 * MailDeliveryError. The SMTP reply code wins over the nodemailer code
 * because it is the more specific signal: EENVELOPE covers both "mailbox
 * full" (4xx, transient) and "no such user" (5xx, permanent).
 */
function toMailDeliveryError(
  error: unknown,
  context: string,
): MailDeliveryError {
  if (error instanceof MailDeliveryError) return error;

  const { code, responseCode } = readTransportFields(error);

  const originalMessage =
    error instanceof Error ? error.message : String(error);

  const message = `${context}: ${originalMessage}`;

  if (typeof responseCode === "number") {
    // 5xx is a permanent SMTP refusal; 4xx asks the sender to come back later.
    const retryable = responseCode < 500;

    return new MailDeliveryError(message, {
      retryable,
      code,
      responseCode,
      cause: error,
    });
  }

  if (code && NON_RETRYABLE_TRANSPORT_CODES.has(code)) {
    return new MailDeliveryError(message, {
      retryable: false,
      code,
      cause: error,
    });
  }

  if (code && RETRYABLE_TRANSPORT_CODES.has(code)) {
    return new MailDeliveryError(message, {
      retryable: true,
      code,
      cause: error,
    });
  }

  // Unknown failures are treated as transient: the pipeline caps attempts
  // anyway, so a wrong guess costs a few retries instead of a lost e-mail.
  return new MailDeliveryError(message, {
    retryable: true,
    code,
    cause: error,
  });
}

/**
 * A template missing from disk is a deploy/packaging bug — every retry reads
 * the same empty path, so it is permanent by definition.
 */
function toTemplateError(error: unknown, path: string): MailDeliveryError {
  const originalMessage =
    error instanceof Error ? error.message : String(error);

  return new MailDeliveryError(
    `Falha ao carregar o template de e-mail "${path}": ${originalMessage}`,
    { retryable: false, cause: error },
  );
}

export { MailDeliveryError, toMailDeliveryError, toTemplateError };
