/**
 * When a webhook is retried, when it is given up on, and when an endpoint is
 * turned off.
 *
 * Pure, because every one of these is a promise to somebody else's on-call
 * engineer: how long their outage can last before events are lost, and how
 * many failures it takes before we stop calling them at all. A decision that
 * needs a live HTTP server to test is a decision nobody tests.
 */

/**
 * Longer than the notification schedule, and deliberately.
 *
 * A customer's integration endpoint goes down for a deploy, a certificate
 * expiry, a Monday morning. Thirty minutes of retries would drop events during
 * an outage nobody was even paged for; six hours covers a working day's
 * accident without holding a row hostage for a week.
 */
const WEBHOOK_RETRY_DELAYS_MS = [
  30_000, //         30s — a restart
  2 * 60_000, //      2m — a rolling deploy
  10 * 60_000, //    10m — a short outage
  60 * 60_000, //     1h — somebody was paged
  6 * 60 * 60_000, // 6h — somebody will be, in the morning
];

/** How long a claimed row stays invisible to other replicas. */
const WEBHOOK_LEASE_SECONDS = 120;

/** How many of one batch are in flight at once. */
const WEBHOOK_CONCURRENCY = 5;

/**
 * Hard ceiling for one call.
 *
 * Ten seconds is generous for an HTTP POST and deliberately shorter than the
 * lease: a customer's hanging endpoint must not be able to hold our worker
 * past the point where another replica reclaims the row and sends the event
 * twice.
 */
const WEBHOOK_TIMEOUT_MS = 10_000;

/**
 * How many consecutive failures before we stop calling an endpoint at all.
 *
 * Not zero and not infinite. A dead URL costs every single event a ten-second
 * timeout, which at a hundred events an hour is a worker doing nothing else —
 * so an endpoint that has failed this many times in a row is switched off and
 * the customer is shown why. Their own `is_active` switch is separate: this
 * one is ours, and turning it back on is a deliberate act.
 */
const MAX_CONSECUTIVE_FAILURES = 20;

/**
 * How long a delivered or failed row stays resendable.
 *
 * Thirty days is the replay window the contract promises, and it is why the
 * payload is copied onto the row instead of read back from the outbox: the
 * outbox purge is free to run on a much shorter horizon.
 */
const REPLAY_WINDOW_DAYS = 30;

/**
 * Whether their answer means "try again" or "this will never work".
 *
 * 2xx is success. 410 Gone is the one refusal a well-behaved receiver uses to
 * say "stop sending me this", and honouring it is the difference between an
 * integration and a nuisance. Every other 4xx is THEIR bug — a malformed
 * route, an expired credential — and retrying gives them the window to fix it
 * without losing the event; 5xx and a timeout are the ordinary transient case.
 */
function isWebhookSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

function isWebhookPermanent(status: number | null): boolean {
  return status === 410;
}

/**
 * Delay before the next try, or null when the attempts are spent.
 *
 * `attempts` is the count already made, including the one that just failed.
 */
function nextWebhookDelayMs(attempts: number): number | null {
  if (attempts > WEBHOOK_RETRY_DELAYS_MS.length) return null;

  return WEBHOOK_RETRY_DELAYS_MS[attempts - 1];
}

/**
 * The same invariant the notification pipeline asserts: a batch has to finish
 * inside its lease, or a second replica reclaims rows the first is still
 * sending and the customer's system receives every event twice.
 */
function assertWebhookLeaseInvariant(
  batchSize: number,
  concurrency: number = WEBHOOK_CONCURRENCY,
  timeoutMs: number = WEBHOOK_TIMEOUT_MS,
  leaseSeconds: number = WEBHOOK_LEASE_SECONDS,
): void {
  const worstCaseMs = Math.ceil(batchSize / concurrency) * timeoutMs;

  if (worstCaseMs >= leaseSeconds * 1000) {
    throw new Error(
      `Webhook lease invariant violated: a batch of ${batchSize} at ` +
        `concurrency ${concurrency} can take ${worstCaseMs}ms, which does ` +
        `not fit in the ${leaseSeconds}s lease. Raise the lease or lower ` +
        `the batch.`,
    );
  }
}

/**
 * How much of their response body is worth keeping.
 *
 * A customer debugging an integration needs the first kilobyte. Keeping more
 * means storing a megabyte of somebody's HTML error page multiplied by every
 * event of the day, forever, in the table the monitor reads.
 */
const RESPONSE_BODY_LIMIT = 1024;

function truncateResponseBody(body: string): string {
  if (body.length <= RESPONSE_BODY_LIMIT) return body;

  return `${body.slice(0, RESPONSE_BODY_LIMIT)}… (truncado)`;
}

export {
  MAX_CONSECUTIVE_FAILURES,
  REPLAY_WINDOW_DAYS,
  RESPONSE_BODY_LIMIT,
  WEBHOOK_CONCURRENCY,
  WEBHOOK_LEASE_SECONDS,
  WEBHOOK_RETRY_DELAYS_MS,
  WEBHOOK_TIMEOUT_MS,
  assertWebhookLeaseInvariant,
  isWebhookPermanent,
  isWebhookSuccess,
  nextWebhookDelayMs,
  truncateResponseBody,
};
