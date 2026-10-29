import database from "@/../infra/database";

import {
  parsePartitionBound,
  type PartitionRange,
} from "@/shared/route/driver-position-rules";

import { isStuck } from "./worker-heartbeat";

/**
 * The state of the machinery behind the queues, for /health/metrics: which
 * workers are alive on which replica (OBS-10), when each cron job last
 * succeeded (OBS-10, INV-07) and how many days of driver_position partitions
 * are left (INV-07). Each read is a handful of rows from a small table.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A replica that has not written its heartbeats for this long is gone
 * (stopped, replaced by a deploy) and is left out; its rows are purged after
 * a day. Twenty flushes' worth, so one slow flush never hides a replica.
 */
const HEARTBEAT_VISIBLE_MS = 10 * 60 * 1000;

/**
 * Below this, the nightly partitions job has missed several runs in a row and
 * inserts are a few days from being refused (no DEFAULT partition).
 */
const RUNWAY_MIN_DAYS = 3;

interface WorkerMetrics {
  replica: string;
  worker: string;
  last_beat_at: string;
  running_since: string | null;
  last_seen_at: string;
  stuck: boolean;
}

async function readWorkerHeartbeats(
  now = new Date(),
): Promise<WorkerMetrics[]> {
  const rows = await database.workerHeartbeat.findMany({
    where: {
      updated_at: { gte: new Date(now.getTime() - HEARTBEAT_VISIBLE_MS) },
    },
    orderBy: [{ replica: "asc" }, { worker: "asc" }],
  });

  return rows.map((row) => ({
    replica: row.replica,
    worker: row.worker,
    last_beat_at: row.lastBeatAt.toISOString(),
    running_since: row.runningSince?.toISOString() ?? null,
    last_seen_at: row.updated_at.toISOString(),
    stuck: isStuck(row, now),
  }));
}

interface CronJobMetrics {
  job: string;

  /** The cron expression, when this replica schedules the job. */
  schedule: string | null;

  last_status: "RUNNING" | "SUCCEEDED" | "FAILED" | null;
  last_scheduled_for: string | null;
  last_finished_at: string | null;
  last_succeeded_at: string | null;
  attempts: number | null;
  last_error: string | null;

  /** RUNNING rows whose lease ran out: a run whose replica died mid-way. */
  stale_running: number;
}

/** Enough of the error to recognise it on a screen. */
const CRON_ERROR_MAX_LENGTH = 500;

/**
 * Every job this replica schedules, plus any job that has rows — so a job
 * that never ran still shows, with nulls, instead of being absent.
 *
 * The success query reads (status, jobName, finishedAt) index-only; the
 * latest-row query walks the (jobName, scheduledFor) unique index. The table
 * holds 30 days of a few firings a day.
 */
async function readCronJobs(
  registered: ReadonlyArray<{ name: string; schedule: string }>,
): Promise<CronJobMetrics[]> {
  // Three reads, one statement (one round trip, one pool checkout): each
  // json_agg'ed subquery keeps its own plan. Timestamps go through
  // AT TIME ZONE 'UTC' so the JSON carries an offset: the columns are
  // timestamp(3) holding UTC, and a bare "2026-10-28T03:00:00" would be
  // parsed as the reader's local time.
  const [row] = await database.$queryRaw<
    Array<{
      latest: Array<{
        jobName: string;
        status: "RUNNING" | "SUCCEEDED" | "FAILED";
        scheduledFor: string;
        finishedAt: string | null;
        attempts: number;
        lastError: string | null;
      }>;
      succeeded: Array<{ jobName: string; last: string | null }>;
      stale: Array<{ jobName: string; n: number }>;
    }>
  >`
    SELECT
      (SELECT coalesce(json_agg(l), '[]'::json) FROM (
        SELECT DISTINCT ON ("jobName")
          "jobName", "status"::text AS status,
          "scheduledFor" AT TIME ZONE 'UTC' AS "scheduledFor",
          "finishedAt" AT TIME ZONE 'UTC' AS "finishedAt",
          "attempts", "lastError"
        FROM "scheduled_job_execution"
        ORDER BY "jobName", "scheduledFor" DESC
      ) l) AS latest,
      (SELECT coalesce(json_agg(s), '[]'::json) FROM (
        SELECT "jobName", max("finishedAt") AT TIME ZONE 'UTC' AS last
        FROM "scheduled_job_execution"
        WHERE "status" = 'SUCCEEDED'
        GROUP BY "jobName"
      ) s) AS succeeded,
      (SELECT coalesce(json_agg(r), '[]'::json) FROM (
        SELECT "jobName", count(*)::int AS n
        FROM "scheduled_job_execution"
        WHERE "status" = 'RUNNING' AND "leaseExpiresAt" < now()
        GROUP BY "jobName"
      ) r) AS stale
  `;

  const iso = (value: string | null | undefined) =>
    value ? new Date(value).toISOString() : null;

  const latest = row?.latest ?? [];
  const succeeded = row?.succeeded ?? [];
  const stale = row?.stale ?? [];

  const schedules = new Map(registered.map((job) => [job.name, job.schedule]));
  const latestBy = new Map(latest.map((row) => [row.jobName, row]));
  const succeededBy = new Map(
    succeeded.map((entry) => [entry.jobName, iso(entry.last)]),
  );
  const staleBy = new Map(stale.map((row) => [row.jobName, row.n]));

  const names = [...new Set([...schedules.keys(), ...latestBy.keys()])].sort();

  return names.map((job) => {
    const row = latestBy.get(job);

    return {
      job,
      schedule: schedules.get(job) ?? null,
      last_status: row?.status ?? null,
      last_scheduled_for: iso(row?.scheduledFor),
      last_finished_at: iso(row?.finishedAt),
      last_succeeded_at: succeededBy.get(job) ?? null,
      attempts: row?.attempts ?? null,
      last_error: row?.lastError?.slice(0, CRON_ERROR_MAX_LENGTH) ?? null,
      stale_running: staleBy.get(job) ?? 0,
    };
  });
}

interface PartitionRunway {
  /** Whole days from now to the end of the last partition; null when none. */
  partition_runway_days: number | null;
  last_partition_ends_at: string | null;
  runway_ok: boolean;
}

/**
 * How long pings can still be stored with no partitions job running.
 *
 * Pure. An unbounded (MAXVALUE) partition means no runway problem at all; a
 * DEFAULT or unreadable bound is ignored, as in the write path.
 */
function partitionRunway(
  ranges: readonly PartitionRange[],
  now: Date = new Date(),
): PartitionRunway {
  if (ranges.length === 0) {
    return {
      partition_runway_days: null,
      last_partition_ends_at: null,
      runway_ok: false,
    };
  }

  const end = Math.max(...ranges.map((range) => range.to));

  if (!Number.isFinite(end)) {
    return {
      partition_runway_days: null,
      last_partition_ends_at: null,
      runway_ok: true,
    };
  }

  const days = Math.floor((end - now.getTime()) / DAY_MS);

  return {
    partition_runway_days: days,
    last_partition_ends_at: new Date(end).toISOString(),
    runway_ok: days >= RUNWAY_MIN_DAYS,
  };
}

/** The attached partitions of driver_position, from the catalogue. */
async function readPartitionRunway(now = new Date()): Promise<PartitionRunway> {
  const bounds = await database.$queryRaw<Array<{ bound: string }>>`
    SELECT pg_get_expr(c.relpartbound, c.oid) AS bound
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = '"driver_position"'::regclass
  `;

  const ranges = bounds
    .map((row) => parsePartitionBound(row.bound))
    .filter((range): range is PartitionRange => range !== null);

  return partitionRunway(ranges, now);
}

export {
  HEARTBEAT_VISIBLE_MS,
  RUNWAY_MIN_DAYS,
  partitionRunway,
  readCronJobs,
  readPartitionRunway,
  readWorkerHeartbeats,
};
export type { CronJobMetrics, PartitionRunway, WorkerMetrics };
