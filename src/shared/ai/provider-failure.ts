import type { ProviderFailureKind } from "./vision-provider";

/**
 * What a provider error means, decided from the facts of the answer and not
 * from the SDK class, so it is the same rule for any provider and testable
 * without one (AI-8).
 *
 * Two answers used to be misread:
 * - the account's spend limit (429 with `enforced_spend_limit_reached`, no
 *   retry-after) was a rate limit: every request spent its four attempts in
 *   ~12 minutes and ended FAILED;
 * - the organisation's own usage limit (400 "You have reached your specified
 *   API usage limits") was a malformed request: the whole queue failed at once.
 * Both are "the provider will not work for anyone right now", which pauses the
 * pipeline instead of failing the requests.
 */
interface ProviderErrorFacts {
  /** HTTP status, undefined for network failures and timeouts. */
  status: number | undefined;

  /** `error.type` of the provider's body (e.g. "rate_limit_error"). */
  errorType?: string | null;

  /** `error.details.error_code` of the provider's body, when present. */
  errorCode?: string | null;

  message: string;
}

const SPEND_LIMIT_CODES = new Set(["enforced_spend_limit_reached"]);

const QUOTA_MESSAGE =
  /spend limit|specified api usage limits|credit balance is too low|billing/i;

function classifyProviderFailure({
  status,
  errorType,
  errorCode,
  message,
}: ProviderErrorFacts): ProviderFailureKind {
  if (errorCode && SPEND_LIMIT_CODES.has(errorCode)) return "quota_exhausted";
  if (status === 402 || errorType === "billing_error") return "quota_exhausted";

  if (status === undefined) return "retryable";

  if (status === 429) {
    return QUOTA_MESSAGE.test(message) ? "quota_exhausted" : "retryable";
  }

  if (status === 400) {
    return QUOTA_MESSAGE.test(message) ? "quota_exhausted" : "permanent";
  }

  if (status === 401 || status === 403) return "unauthorized";

  if (status === 404 || status === 413 || status === 422) return "permanent";

  // 408, 409, 5xx and the provider's 529 "overloaded".
  return "retryable";
}

/**
 * The prefix a request's lastError carries when the provider paused the
 * pipeline, so /health and a person reading the row both see why it waits.
 */
const PROVIDER_PAUSED_MARKER = "AI_PROVIDER_PAUSED";

/** The prefix of an answer that failed the schema (AI-14). */
const INVALID_RESPONSE_MARKER = "AI_INVALID_RESPONSE";

/**
 * The prefix of a request settled without a call because the record no
 * longer holds the photo or value it was going to read (AI-4).
 */
const INPUT_SUPERSEDED_MARKER = "AI_INPUT_SUPERSEDED";

/**
 * The lastError of a unit given back because the reader does not answer its
 * kind (ADR 0010 §5): a checklist item queued for a vision model, found by
 * the OCR reader. Released, never consumed: it costs no quota.
 */
const UNSUPPORTED_BY_READER_MARKER = "unsupported_by_reader";

export {
  INPUT_SUPERSEDED_MARKER,
  UNSUPPORTED_BY_READER_MARKER,
  INVALID_RESPONSE_MARKER,
  PROVIDER_PAUSED_MARKER,
  classifyProviderFailure,
};
export type { ProviderErrorFacts };
