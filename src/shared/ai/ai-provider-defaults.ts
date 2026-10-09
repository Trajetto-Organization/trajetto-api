/**
 * The reader's defaults, in a file with no imports: the env schema reads them
 * from here, and the benchmark (scripts/ai-benchmark) too — the numbers it
 * measures are the ones the product runs with (ADR 0010, 05/10/2026).
 */

/**
 * The budget of one call to the local OCR service (trajetto-ai), which has to
 * fit in the request's lease (assertAILeaseInvariant, asserted when the
 * pipeline loads): 15 s of photo fetch + 15 s here, against 300 s.
 *
 * The p95 measured was 1.72 s at 4 CPU; 15 s covers a slower VPS and the
 * service's own queue (it turns a request away with 503 after 10 s of
 * waiting, which the pipeline treats as "busy", not as a failure).
 */
const LOCAL_AI_DEFAULT_TIMEOUT_MS = 15_000;

/** No retry in the client: the pipeline's backoff does that. */
const LOCAL_AI_MAX_RETRIES = 0;

/**
 * Reads in flight per API replica. The service reads one photo at a time
 * with a queue of 2: with 2 replicas at 1 each, the queue is never the
 * bottleneck and nothing waits past the service's 10 s.
 */
const LOCAL_AI_DEFAULT_MAX_CONCURRENCY = 1;

export {
  LOCAL_AI_DEFAULT_MAX_CONCURRENCY,
  LOCAL_AI_DEFAULT_TIMEOUT_MS,
  LOCAL_AI_MAX_RETRIES,
};
