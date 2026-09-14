interface SendMessageProps {
  phoneNumber: string;
  message: string;
}

/**
 * Outcome of a single send attempt.
 *
 * The provider is the only layer that can read Meta's answer, so it also
 * classifies it: the caller must never have to re-parse error payloads to
 * decide whether another attempt makes sense. A rejected template, an opted
 * out recipient and an expired token are permanent — retrying them only burns
 * attempts and delays the dead-letter — while a rate limit or a 5xx is worth
 * repeating.
 */
interface WhatsAppResponse<T = unknown> {
  success: boolean;
  message: string;
  /**
   * Whether sending the exact same payload again could plausibly succeed.
   * Always `false` on success — there is nothing left to retry.
   */
  retryable: boolean;
  /** Meta Cloud API error code, when the response carried one. */
  errorCode?: number;
  /** HTTP status returned by Graph; absent when the request never completed. */
  httpStatus?: number;
  /**
   * Meta's id for the accepted message (`wamid.*`). Kept so a later status
   * webhook can be matched back to the delivery that produced it.
   */
  messageId?: string;
  /**
   * Value of the `Retry-After` header, in seconds, when Meta throttled the
   * request. The caller should wait at least this long before retrying.
   */
  retryAfterSeconds?: number;
  data?: T;
}

export { SendMessageProps, WhatsAppResponse };
