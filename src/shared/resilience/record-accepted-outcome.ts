/**
 * Recording an outcome the outside world ALREADY accepted (a WhatsApp Meta
 * took, a webhook the customer answered 200 to).
 *
 * Giving up early is what duplicates messages: the row stays PROCESSING, its
 * lease runs out and another replica sends it again. While the claim's lease
 * lives no other replica can take the row, and every write is fenced to the
 * claim (id, PROCESSING, attempts), so retrying the write until shortly
 * before the lease ends is safe — a write that lands after a reclaim simply
 * matches nothing.
 *
 * The first retries run inline (a blip costs the batch a few seconds at
 * most). After that the retries continue DETACHED, so a long database outage
 * never holds the batch — the batch-vs-lease invariant is untouched — and
 * each detached loop is bounded by its own row's lease.
 */

/** Inline retries: what a connection blip needs. */
const RECORD_INLINE_RETRY_DELAYS_MS = [250, 1_000, 3_000] as const;

/** Stop retrying this long before the lease ends: a reclaim may be close. */
const RECORD_LEASE_MARGIN_MS = 15_000;

/** Detached back-off: 2 s, 4 s, 8 s, then every 10 s until the deadline. */
function detachedRecordDelayMs(retry: number): number {
  return Math.min(10_000, 2_000 * 2 ** retry);
}

/**
 * The instant after which no more record attempts start: the lease length
 * counted from BEFORE the claim statement was sent (the database's lease can
 * only end later than that), minus the margin.
 */
function recordDeadline(
  claimStartedAtMs: number,
  leaseSeconds: number,
): number {
  return claimStartedAtMs + leaseSeconds * 1000 - RECORD_LEASE_MARGIN_MS;
}

interface RecordAcceptedOptions {
  /** The fenced write. Throws when the database cannot take it. */
  write: () => Promise<void>;
  /** Epoch ms; see recordDeadline. */
  deadline: number;
  /** Called once when the inline retries ran out and a detached loop starts. */
  onDetached?: (error: unknown) => void;
  /** Called once when every attempt up to the deadline failed. */
  onGiveUp: (error: unknown) => void;
  /** Receives the detached loop, so shutdown and tests can wait for it. */
  track?: (pending: Promise<void>) => void;
  /** Injectable for tests of the schedule; production uses setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const realSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Resolves once the write succeeded or the inline retries ran out; in the
 * second case the detached loop goes on by itself (see `track`).
 * Never throws.
 */
async function recordAcceptedOutcome(
  options: RecordAcceptedOptions,
): Promise<void> {
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? Date.now;

  let lastError: unknown;

  for (let attempt = 0; ; attempt += 1) {
    try {
      await options.write();
      return;
    } catch (error) {
      lastError = error;
    }

    const wait = RECORD_INLINE_RETRY_DELAYS_MS[attempt];

    if (wait === undefined) break;
    if (now() + wait > options.deadline) {
      options.onGiveUp(lastError);
      return;
    }

    await sleep(wait);
  }

  options.onDetached?.(lastError);

  const detached = (async () => {
    for (let retry = 0; ; retry += 1) {
      const wait = detachedRecordDelayMs(retry);

      if (now() + wait > options.deadline) {
        options.onGiveUp(lastError);
        return;
      }

      await sleep(wait);

      try {
        await options.write();
        return;
      } catch (error) {
        lastError = error;
      }
    }
    // A throwing callback must not become an unhandled rejection that
    // takes the worker process down.
  })().catch(() => undefined);

  options.track?.(detached);
}

export {
  RECORD_INLINE_RETRY_DELAYS_MS,
  RECORD_LEASE_MARGIN_MS,
  detachedRecordDelayMs,
  recordAcceptedOutcome,
  recordDeadline,
};
export type { RecordAcceptedOptions };
