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

/**
 * The most times a row is ever claimed. One more than the retry schedule, so
 * the schedule runs to completion — and a ceiling on the reclaim of a row
 * whose attempt died with the process. That row used to be claimed again at
 * every lease expiry, forever: if what killed the process was the row itself
 * (a response built to exhaust memory), every replica took its turn to die.
 */
const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_RETRY_DELAYS_MS.length + 1;

/**
 * How much of an endpoint's answer is read, decompressed, before the worker
 * stops listening. The monitor shows the first kilobyte; a little more is read
 * so a multi-byte character at the edge does not break the truncation.
 */
const RESPONSE_READ_LIMIT_BYTES = 8 * 1024;

/** How long a claimed row stays invisible to other replicas. */
const WEBHOOK_LEASE_SECONDS = 120;

/** How many of one batch are in flight at once. */
const WEBHOOK_CONCURRENCY = 5;

/**
 * The fairness between customers.
 *
 * The claim was the oldest twenty rows, whoever they belonged to, sent in
 * waves of five that each lasted as long as their slowest call. One tenant's
 * endpoint answering in nine seconds — alive, correct, never tripping the
 * breaker — set the pace for every other tenant's webhooks, and a backlog of
 * its rows pushed everyone else's behind them.
 *
 * Now one claim takes at most WEBHOOK_PER_ENDPOINT_BATCH rows of any single
 * endpoint, and at most WEBHOOK_PER_ENDPOINT_CONCURRENCY calls to one endpoint
 * are in flight at a time; the other slots keep moving.
 */
const WEBHOOK_PER_ENDPOINT_BATCH = 10;
const WEBHOOK_PER_ENDPOINT_CONCURRENCY = 2;

/**
 * How many of the oldest due rows a claim looks at when choosing fairly.
 *
 * Bounded so the choice costs an index range, not the whole backlog.
 */
const WEBHOOK_CLAIM_WINDOW = 500;

/**
 * How long one sweep keeps claiming while there is work.
 *
 * It used to stop after twenty rows and wait five seconds, whatever the
 * receivers could take: a ceiling of four rows a second per replica.
 */
const WEBHOOK_DRAIN_BUDGET_MS = 20_000;

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
 * How many endpoints one company may register.
 *
 * The fan-out writes one row per interested endpoint INSIDE the transaction of
 * the fact it announces, so every endpoint multiplies the writes of every
 * delivery the company creates or changes. Unbounded, a company administrator
 * could slow the company's own operation — and the queue everyone shares —
 * with a few hundred copies of the same URL (DLVB-24). Ten, like the API keys.
 */
const MAX_WEBHOOK_ENDPOINTS_PER_BUSINESS = 10;

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
  perEndpointBatch: number = WEBHOOK_PER_ENDPOINT_BATCH,
  perEndpointConcurrency: number = WEBHOOK_PER_ENDPOINT_CONCURRENCY,
): void {
  // The slower of two bounds: the batch through all the slots, or one
  // endpoint's share through the slots it is allowed.
  const rounds = Math.max(
    Math.ceil(batchSize / concurrency),
    Math.ceil(Math.min(perEndpointBatch, batchSize) / perEndpointConcurrency),
  );

  const worstCaseMs = rounds * timeoutMs;

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
 * Runs `work` over `items`, `concurrency` at a time and at most `perKey`
 * per key, taking the next item that may start as soon as a slot frees.
 *
 * Not waves: a wave lasts as long as its slowest member, so one slow call held
 * four free slots idle. `work` is expected to handle its own failures; one
 * that throws anyway does not stop the rest.
 */
async function inFairPool<T>(
  items: T[],
  options: { concurrency: number; perKey: number; keyOf: (item: T) => string },
  work: (item: T) => Promise<void>,
): Promise<void> {
  const waiting = [...items];
  const inFlight = new Map<string, number>();

  let running = 0;

  await new Promise<void>((done) => {
    const startWhatCan = () => {
      if (waiting.length === 0 && running === 0) {
        done();
        return;
      }

      while (running < options.concurrency) {
        const index = waiting.findIndex(
          (item) => (inFlight.get(options.keyOf(item)) ?? 0) < options.perKey,
        );

        if (index < 0) break;

        const [item] = waiting.splice(index, 1);
        const key = options.keyOf(item);

        inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
        running += 1;

        work(item)
          .catch(() => undefined)
          .finally(() => {
            inFlight.set(key, (inFlight.get(key) ?? 1) - 1);
            running -= 1;
            startWhatCan();
          });
      }
    };

    startWhatCan();
  });
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
  // Postgres refuses NUL in a text column. A body carrying one made the row
  // update throw — and when that update was the one recording a 200, the
  // failure path took over and the already-delivered event was sent again.
  const storable = body.replace(/\u0000/g, "");

  if (storable.length <= RESPONSE_BODY_LIMIT) return storable;

  return `${storable.slice(0, RESPONSE_BODY_LIMIT)}… (truncado)`;
}

/**
 * An endpoint that may not be delivered to — paused by the customer or
 * switched off by the breaker — HOLDS its events instead of receiving or
 * losing them: the row waits, out of the claim's way, until somebody saves
 * the endpoint again or the replay window runs out.
 */
const ENDPOINT_PAUSED_REASON =
  `Endpoint pausado ou desligado: o evento aguarda a reativação (até ${REPLAY_WINDOW_DAYS} dias).`;

const REPLAY_WINDOW_EXPIRED_REASON =
  `O evento passou ${REPLAY_WINDOW_DAYS} dias sem poder ser entregue e foi encerrado.`;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Until when a held row waits: the end of its replay window. */
function parkedUntil(createdAt: Date): Date {
  return new Date(createdAt.getTime() + REPLAY_WINDOW_DAYS * DAY_MS);
}

function isOutsideReplayWindow(createdAt: Date, now: Date = new Date()): boolean {
  return now.getTime() - createdAt.getTime() >= REPLAY_WINDOW_DAYS * DAY_MS;
}

export {
  ENDPOINT_PAUSED_REASON,
  REPLAY_WINDOW_EXPIRED_REASON,
  isOutsideReplayWindow,
  parkedUntil,
  MAX_CONSECUTIVE_FAILURES,
  MAX_WEBHOOK_ENDPOINTS_PER_BUSINESS,
  RESPONSE_READ_LIMIT_BYTES,
  WEBHOOK_MAX_ATTEMPTS,
  REPLAY_WINDOW_DAYS,
  RESPONSE_BODY_LIMIT,
  WEBHOOK_CLAIM_WINDOW,
  WEBHOOK_CONCURRENCY,
  WEBHOOK_DRAIN_BUDGET_MS,
  WEBHOOK_LEASE_SECONDS,
  WEBHOOK_PER_ENDPOINT_BATCH,
  WEBHOOK_PER_ENDPOINT_CONCURRENCY,
  WEBHOOK_RETRY_DELAYS_MS,
  WEBHOOK_TIMEOUT_MS,
  assertWebhookLeaseInvariant,
  inFairPool,
  isWebhookPermanent,
  isWebhookSuccess,
  nextWebhookDelayMs,
  truncateResponseBody,
};
