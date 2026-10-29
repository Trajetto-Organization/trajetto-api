interface SendMessageProps {
  phoneNumber: string;
  message: string;

  /**
   * The notification delivery this send belongs to. Travels to Meta as
   * `biz_opaque_callback_data` and comes back on every status callback, so
   * each wamid can be traced to its delivery — including the one whose send
   * succeeded right before a crash and was never recorded here, which is the
   * only way a duplicate becomes visible (Meta has no idempotency key).
   */
  referenceId?: string;

  /**
   * Who reads it. `customer` is a carrier writing to its own customer, which
   * goes out under the customer template when one is configured, so a spam
   * report there cannot pause the template the internal notices use.
   * Absent means `internal`.
   */
  audience?: "internal" | "customer";
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
