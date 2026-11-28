import { env } from "@/env";
import { registerSampleSection } from "@/shared/health/ops-sample";
import { withoutRequestContext } from "@/shared/http/request-context";
import { logger } from "@/shared/logging/logger";
import { isMissingPartition } from "@/shared/route/driver-position-rules";

import type {
  IDriverPositionRepository,
  PositionWrite,
  RecordedBatch,
} from "../repositories/IDriver-position-repository";

const log = logger.child({ component: "position-group-commit" });

/**
 * The GPS group commit (plano-escala F5-19), behind POSITION_GROUP_COMMIT.
 *
 * POST /route/positions is the busiest route by an order of magnitude: at
 * the plan's ceiling, ~333 flushes a second, each one its own transaction
 * and its own commit (a WAL flush). With `on`, the flushes that reach this
 * process within a short window go to the database together, in one
 * transaction (DriverPositionRepository.writeBatchMany), and each request
 * is answered with its own result only after that COMMIT: a 2xx still
 * means the points are in the database, as before.
 *
 *  - the window: 50 ms after the first flush waiting, or 1.000 points,
 *    whichever comes first (a phone's flush has at most 1.000 points, so a
 *    flush is never split);
 *  - one batch at a time (single flight): what arrives while a batch
 *    commits waits for it and goes in the next one, so a slow commit makes
 *    the batches bigger instead of piling transactions on the pool;
 *  - a failed batch is redone flush by flush on today's path (recordBatch),
 *    concurrently, each answered by its own outcome. A point no partition
 *    holds fails the batch it is in; recordBatch drops it alone (INV-14),
 *    and that is the flush's data, not the path's health, so it does not
 *    count for the breaker;
 *  - the breaker: after 5 failed batches in a row, a minute of today's path
 *    for every flush; then one batch tries again, and a failure reopens it
 *    at once. Each opening is a log line at error level and a count in the
 *    process's ops_sample row (`position_group_commit.breaker_opens`): the
 *    owner turns it on in production only after seven days of staging
 *    without one (plano-escala-execucao, wave 19);
 *  - the drain: on the way out (server.ts, shared/lifecycle/shutdown.ts)
 *    the waiting flushes go at once, without the window, and every flush
 *    after that takes today's path.
 *
 * `off` (the default) is one transaction per flush, exactly as before.
 * The batch runs outside the request context of the flush that started it
 * (withoutRequestContext): its statements are nobody's request in
 * particular.
 */

const GROUP_COMMIT_WINDOW_MS = 50;
const GROUP_COMMIT_MAX_POINTS = 1_000;
const BREAKER_FAILURES = 5;
const BREAKER_COOLDOWN_MS = 60_000;

type PositionWriter = Pick<
  IDriverPositionRepository,
  "recordBatch" | "writeBatchMany"
>;

interface PositionWriteBufferOptions {
  windowMs?: number;
  maxPoints?: number;
  breakerFailures?: number;
  breakerCooldownMs?: number;
  now?: () => number;
}

interface PositionWriteBuffer {
  /** The flush's result, once it is committed (batched or on its own). */
  record: (write: PositionWrite) => Promise<RecordedBatch>;

  /** Writes what waits now; every flush after this takes today's path. */
  drain: () => Promise<void>;

  state: () => {
    pending: number;
    inflight: boolean;
    breakerOpen: boolean;
    draining: boolean;
  };
}

interface Waiting {
  write: PositionWrite;
  resolve: (result: RecordedBatch) => void;
  reject: (error: unknown) => void;
}

/** The minute's numbers, for the `position_group_commit` sample section. */
const counts = {
  batches: 0,
  flushes: 0,
  points: 0,
  failed_batches: 0,
  fallback_flushes: 0,
  breaker_opens: 0,
};

let breakerOpenNow = false;

function takeGroupCommitCounts(): typeof counts & { breaker_open: boolean } {
  const taken = { ...counts, breaker_open: breakerOpenNow };

  for (const key of Object.keys(counts) as Array<keyof typeof counts>) {
    counts[key] = 0;
  }

  return taken;
}

registerSampleSection("position_group_commit", takeGroupCommitCounts);

function createPositionWriteBuffer(
  repository: PositionWriter,
  options: PositionWriteBufferOptions = {},
): PositionWriteBuffer {
  const windowMs = options.windowMs ?? GROUP_COMMIT_WINDOW_MS;
  const maxPoints = options.maxPoints ?? GROUP_COMMIT_MAX_POINTS;
  const breakerFailures = options.breakerFailures ?? BREAKER_FAILURES;
  const cooldownMs = options.breakerCooldownMs ?? BREAKER_COOLDOWN_MS;
  const now = options.now ?? Date.now;

  let waiting: Waiting[] = [];
  let waitingPoints = 0;
  let timer: NodeJS.Timeout | null = null;
  let due = false;
  let inflight: Promise<void> | null = null;
  let draining = false;
  let failures = 0;
  let openUntil = 0;

  const breakerOpen = () => failures >= breakerFailures && now() < openUntil;

  /** Up to maxPoints of the oldest flushes; always at least one. */
  const take = (): Waiting[] => {
    let points = 0;
    let count = 0;

    while (count < waiting.length) {
      const size = waiting[count].write.pings.length;

      if (count > 0 && points + size > maxPoints) break;

      points += size;
      count += 1;
    }

    const batch = waiting.slice(0, count);

    waiting = waiting.slice(count);
    waitingPoints -= points;

    return batch;
  };

  const failed = (error: unknown, size: number): void => {
    counts.failed_batches += 1;

    if (isMissingPartition(error)) {
      log.info(
        { flushes: size },
        "a batch had a point no partition holds; its flushes go one by one",
      );
      return;
    }

    failures += 1;

    if (failures >= breakerFailures) {
      openUntil = now() + cooldownMs;
      breakerOpenNow = true;
      counts.breaker_opens += 1;

      log.error(
        { err: error, failures, cooldownMs },
        "position group commit breaker open: one transaction per flush for now",
      );
    } else if (failures === 1) {
      log.warn(
        { err: error, flushes: size },
        "position batch failed; its flushes go one by one",
      );
    }
  };

  const run = async (batch: Waiting[]): Promise<void> => {
    let results: RecordedBatch[];

    try {
      results = await repository.writeBatchMany(
        batch.map((entry) => entry.write),
      );
    } catch (error) {
      failed(error, batch.length);
      counts.fallback_flushes += batch.length;

      // Each flush on today's path, answered by its own outcome. Awaited
      // here, so the next batch does not pile on a database that just
      // failed one.
      await Promise.all(
        batch.map((entry) =>
          repository.recordBatch(entry.write).then(entry.resolve, entry.reject),
        ),
      );

      return;
    }

    if (failures > 0) {
      log.info({ failures }, "position batches commit again");
    }

    failures = 0;
    breakerOpenNow = false;

    counts.batches += 1;
    counts.flushes += batch.length;

    batch.forEach((entry, index) => {
      counts.points += entry.write.pings.length;
      entry.resolve(results[index]);
    });
  };

  const disarm = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const kick = (): void => {
    if (waiting.length === 0) return;

    // The breaker opened while these waited: today's path, now.
    if (breakerOpen()) {
      disarm();

      const stranded = waiting;

      waiting = [];
      waitingPoints = 0;
      due = false;

      for (const entry of stranded) {
        repository.recordBatch(entry.write).then(entry.resolve, entry.reject);
      }

      return;
    }

    // The window runs while a batch commits, so what waited through a
    // slow commit goes as soon as it ends.
    if (!due) {
      if (!timer) {
        timer = withoutRequestContext(() =>
          setTimeout(() => {
            timer = null;
            due = true;
            kick();
          }, windowMs),
        );
      }

      return;
    }

    // Due, and one batch at a time: right after the commit in flight.
    if (inflight) return;

    disarm();

    const batch = take();

    // What did not fit has waited a whole batch already.
    due = waiting.length > 0;

    inflight = withoutRequestContext(() => run(batch)).finally(() => {
      inflight = null;
      kick();
    });
  };

  return {
    record: (write) => {
      if (draining || write.pings.length === 0 || breakerOpen()) {
        return repository.recordBatch(write);
      }

      return new Promise<RecordedBatch>((resolve, reject) => {
        waiting.push({ write, resolve, reject });
        waitingPoints += write.pings.length;

        if (waitingPoints >= maxPoints) due = true;

        kick();
      });
    },

    drain: async () => {
      draining = true;
      due = true;
      kick();

      while (inflight) await inflight;
    },

    state: () => ({
      pending: waiting.length,
      inflight: inflight !== null,
      breakerOpen: breakerOpen(),
      draining,
    }),
  };
}

/** One buffer per repository: the container's singleton, in production. */
const buffers = new Map<PositionWriter, PositionWriteBuffer>();

/**
 * Where RecordDriverPositionsUseCase writes a flush: through this
 * process's group commit with POSITION_GROUP_COMMIT=on, straight to
 * recordBatch otherwise. Read on every call.
 */
function recordPositions(
  repository: PositionWriter,
  write: PositionWrite,
): Promise<RecordedBatch> {
  if (env.POSITION_GROUP_COMMIT !== "on") return repository.recordBatch(write);

  let buffer = buffers.get(repository);

  if (!buffer) {
    buffer = createPositionWriteBuffer(repository);
    buffers.set(repository, buffer);
  }

  return buffer.record(write);
}

/** The shutdown's step: every buffer of this process written out. */
async function drainPositionWriteBuffers(): Promise<void> {
  await Promise.all([...buffers.values()].map((buffer) => buffer.drain()));
}

export {
  BREAKER_COOLDOWN_MS,
  BREAKER_FAILURES,
  GROUP_COMMIT_MAX_POINTS,
  GROUP_COMMIT_WINDOW_MS,
  createPositionWriteBuffer,
  drainPositionWriteBuffers,
  recordPositions,
  takeGroupCommitCounts,
};
export type { PositionWriteBuffer, PositionWriteBufferOptions };
