import os from "node:os";

import { Prisma } from "@prisma/client";

import database from "@/../infra/database";
import { logger } from "@/shared/logging/logger";

const log = logger.child({ component: "worker-heartbeat" });

/**
 * Where each background worker of this process was last seen making progress
 * (OBS-10).
 *
 * The workers (notification outbox and delivery lanes, AI analyses, webhook
 * dispatch) guard their cycles with an in-memory flag released only in a
 * `finally`. A cycle stuck on an await that never returns keeps the flag set:
 * every later sweep returns at once and the replica's worker has stopped for
 * good — with /health/liveness still answering 200, since it must not touch
 * dependencies. Nothing outside the process could tell.
 *
 * Each cycle now beats at its start, at every batch and at its end, and every
 * replica writes its beats to worker_heartbeat so /health/metrics (and the
 * alerting) see all replicas, not only the one that answered. Deliberately
 * NOT wired into liveness: restarting a replica because a query hangs is the
 * restart loop the liveness rule exists to prevent.
 */

/**
 * No beat for this long = stuck. Every worker sweeps at least every 30 s and
 * beats at each batch, so ten minutes of silence is never a slow provider: it
 * is a cycle hung mid-flight (runningSince set) or a sweep that stopped firing
 * (runningSince null).
 */
const STUCK_AFTER_MS = 10 * 60 * 1000;

/** How often each replica writes its beats. */
const FLUSH_INTERVAL_MS = 30 * 1000;

interface HeartbeatEntry {
  worker: string;

  /** The last sign of progress. */
  lastBeatAt: Date;

  /** When the cycle in progress started; null between cycles. */
  runningSince: Date | null;
}

class WorkerHeartbeatRegistry {
  private entries = new Map<
    string,
    { lastBeatAt: Date; runningSince: Date | null }
  >();

  /** The clock is injectable so the rules can be tested without timers. */
  constructor(private readonly clock: () => Date = () => new Date()) {}

  /** Right after the cycle's reentrancy flag was taken. */
  beginCycle(worker: string): void {
    const now = this.clock();

    this.entries.set(worker, { lastBeatAt: now, runningSince: now });
  }

  /** At each batch of a cycle that drains more than one. */
  progress(worker: string): void {
    const now = this.clock();
    const entry = this.entries.get(worker);

    if (entry) {
      entry.lastBeatAt = now;
    } else {
      this.entries.set(worker, { lastBeatAt: now, runningSince: now });
    }
  }

  /** In the cycle's `finally`, whatever happened inside. */
  endCycle(worker: string): void {
    this.entries.set(worker, { lastBeatAt: this.clock(), runningSince: null });
  }

  snapshot(): HeartbeatEntry[] {
    return [...this.entries].map(([worker, entry]) => ({
      worker,
      lastBeatAt: entry.lastBeatAt,
      runningSince: entry.runningSince,
    }));
  }
}

function isStuck(
  entry: Pick<HeartbeatEntry, "lastBeatAt">,
  now: Date = new Date(),
  stuckAfterMs: number = STUCK_AFTER_MS,
): boolean {
  return now.getTime() - entry.lastBeatAt.getTime() > stuckAfterMs;
}

/** The process-wide registry the workers beat into. */
const workerHeartbeat = new WorkerHeartbeatRegistry();

/** The container's hostname: one per Swarm task, which is what "replica" means here. */
const REPLICA = os.hostname();

/**
 * Writes this replica's beats, one row per worker, in one statement.
 *
 * Timestamps go as ISO strings converted in SQL to UTC `timestamp` — the
 * columns are timestamp(3) without time zone holding UTC, as everywhere in
 * this schema. updated_at is set on both sides of the upsert: @updatedAt is
 * applied by the Prisma client, never by raw SQL.
 */
async function flushHeartbeats(
  registry: WorkerHeartbeatRegistry = workerHeartbeat,
  replica: string = REPLICA,
): Promise<void> {
  const entries = registry.snapshot();

  if (entries.length === 0) return;

  const rows = entries.map(
    (entry) => Prisma.sql`(
      ${replica},
      ${entry.worker},
      (${entry.lastBeatAt.toISOString()}::timestamptz AT TIME ZONE 'UTC'),
      (${entry.runningSince?.toISOString() ?? null}::timestamptz AT TIME ZONE 'UTC'),
      now()
    )`,
  );

  await database.$executeRaw`
    INSERT INTO "worker_heartbeat"
      ("replica", "worker", "lastBeatAt", "runningSince", "updated_at")
    VALUES ${Prisma.join(rows)}
    ON CONFLICT ("replica", "worker") DO UPDATE SET
      "lastBeatAt" = EXCLUDED."lastBeatAt",
      "runningSince" = EXCLUDED."runningSince",
      "updated_at" = now()
  `;
}

/**
 * Starts the periodic flush; returns the function that stops it. Unref'd, and
 * fail-open: a flush that fails (the database, again) is logged and retried on
 * the next tick — the heartbeat must never be what takes a worker down.
 */
function startHeartbeatFlush(
  intervalMs: number = FLUSH_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => {
    flushHeartbeats().catch((error) => {
      log.warn({ err: error }, "worker heartbeat flush failed");
    });
  }, intervalMs);

  timer.unref();

  return () => clearInterval(timer);
}

export {
  FLUSH_INTERVAL_MS,
  REPLICA,
  STUCK_AFTER_MS,
  WorkerHeartbeatRegistry,
  flushHeartbeats,
  isStuck,
  startHeartbeatFlush,
  workerHeartbeat,
};
export type { HeartbeatEntry };
