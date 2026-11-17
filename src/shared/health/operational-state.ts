import database from "@/../infra/database";

import {
  PARTIAL_RUN_MARKER,
  isPartialRunMessage,
} from "@/shared/errors/partial-run-error";
import { PARTITION_OWNER_ROLE } from "@/shared/database/partition-owner";
import {
  registeredPartitions,
  retentionCutoff,
  type PartitionedTable,
} from "@/shared/database/partitions";
import {
  parsePartitionBound,
  type PartitionRange,
} from "@/shared/route/driver-position-rules";

import { isStuck } from "./worker-heartbeat";

/**
 * The state of the machinery behind the queues, for /health/metrics: which
 * workers are alive on which replica (OBS-10), when each cron job last
 * succeeded (OBS-10, INV-07) and how the partitions of every registered
 * table stand (INV-07, plano-escala F2-09). Each read is a handful of rows
 * from a small table or from the catalog.
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

/**
 * Below this, the lookahead is being eaten (plano-escala F2-09): the job
 * keeps 7 days ahead, so right before its run there are 6; under 5 means
 * two nights in a row without it, with days still left to act before a
 * position or a queue row is refused. The earlier warning of the two.
 */
const LOOKAHEAD_MIN_DAYS = 5;

/**
 * A partition past the retention by more than this is stuck: three nights
 * of the job failing to detach or drop it (a lock that never came, a
 * DETACH left pending, a permission). The disk keeps it until somebody
 * looks.
 */
const PARTITION_STUCK_GRACE_DAYS = 3;

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

  /**
   * The latest run stopped with work left (FAILED "[partial]", F1-17): the
   * catch-up sweep retries it inside the partial window.
   */
  last_partial: boolean;

  /**
   * The first partial run since the last success: how long the job has
   * done nothing but partials. Null when the latest run is not partial, and
   * when a run that really failed came after the last success: then the
   * job is not "only slow", and the alert judges it by its last success.
   */
  partial_since: string | null;
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
 *
 * The partial streak takes every FAILED run since the last success and
 * keeps the job only when all of them were partial (HAVING bool_and; a
 * NULL lastError counts as a real failure). It used to keep only the
 * partials and date them from the last success, so a statement timeout on
 * two nights and one partial on the third read as a fresh streak: the
 * alert gave the job 26 h more of grace while it had not succeeded in 72.
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
      partial: Array<{ jobName: string; since: string | null }>;
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
      ) r) AS stale,
      (SELECT coalesce(json_agg(p), '[]'::json) FROM (
        SELECT e."jobName", min(e."scheduledFor") AT TIME ZONE 'UTC' AS since
        FROM "scheduled_job_execution" e
        WHERE e."status" = 'FAILED'
          AND e."scheduledFor" > coalesce((
            SELECT max(s."scheduledFor") FROM "scheduled_job_execution" s
            WHERE s."jobName" = e."jobName" AND s."status" = 'SUCCEEDED'
          ), '-infinity'::timestamp)
        GROUP BY e."jobName"
        HAVING bool_and(
          coalesce(starts_with(e."lastError", ${PARTIAL_RUN_MARKER}), false)
        )
      ) p) AS partial
  `;

  const iso = (value: string | null | undefined) =>
    value ? new Date(value).toISOString() : null;

  const latest = row?.latest ?? [];
  const succeeded = row?.succeeded ?? [];
  const stale = row?.stale ?? [];
  const partial = row?.partial ?? [];

  const schedules = new Map(registered.map((job) => [job.name, job.schedule]));
  const latestBy = new Map(latest.map((row) => [row.jobName, row]));
  const succeededBy = new Map(
    succeeded.map((entry) => [entry.jobName, iso(entry.last)]),
  );
  const staleBy = new Map(stale.map((row) => [row.jobName, row.n]));
  const partialBy = new Map(
    partial.map((entry) => [entry.jobName, iso(entry.since)]),
  );

  const names = [...new Set([...schedules.keys(), ...latestBy.keys()])].sort();

  return names.map((job) => {
    const row = latestBy.get(job);
    const lastPartial =
      row?.status === "FAILED" && isPartialRunMessage(row.lastError);
    const partialSince = lastPartial ? partialBy.get(job) : undefined;

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
      last_partial: lastPartial,
      partial_since: partialSince ?? null,
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

/** One partitioned table on /health/metrics (`partitions.<table>`). */
interface PartitionTableMetrics {
  /** Attached partitions, a pending detach included. */
  partitions: number;

  /** Whole days until the last partition ends; null when there is none. */
  lookahead_days: number | null;
  last_partition_ends_at: string | null;
  oldest_partition_starts_at: string | null;
  retention_days: number;

  /** At least 3 days ahead (partition-runway-low under it). */
  runway_ok: boolean;

  /** At least 5 days ahead (partition-lookahead-low under it). */
  lookahead_ok: boolean;

  /** Partitions a DETACH … CONCURRENTLY left half-way. */
  detach_pending: number;

  /** Partitions past the retention by more than 3 days: never dropped. */
  stuck: string[];

  /**
   * trajetto_partitions owns the parent and every partition
   * (infra/sql/10-partitions.sql): the job can run as it, which is what a
   * runtime without a superuser needs.
   */
  owner_ok: boolean;
}

interface PartitionCatalogRow {
  relname: string;
  bound: string | null;
  detach_pending: boolean;
  owned: boolean;
}

/**
 * How one table's partitions stand. Pure: the catalog's rows, the
 * registry's entry and an instant. A table that keeps no lookahead (one
 * being retired, whose rows go to its successor) is not judged on it.
 */
function partitionTableState(
  table: PartitionedTable,
  parent: { owned: boolean } | null,
  rows: readonly PartitionCatalogRow[],
  now: Date = new Date(),
): PartitionTableMetrics {
  const ranged = rows.map((row) => ({
    row,
    range: row.bound ? parsePartitionBound(row.bound) : null,
  }));
  const ranges = ranged
    .map((each) => each.range)
    .filter((range): range is PartitionRange => range !== null);

  const runway = partitionRunway(ranges, now);
  const judged = table.lookahead > 0;
  const days = runway.partition_runway_days;
  const unbounded = ranges.length > 0 && days === null && runway.runway_ok;

  const stuckBy =
    retentionCutoff(table, now).getTime() - PARTITION_STUCK_GRACE_DAYS * DAY_MS;
  const starts = ranges
    .map((range) => range.from)
    .filter((from) => Number.isFinite(from));

  return {
    partitions: rows.length,
    lookahead_days: days,
    last_partition_ends_at: runway.last_partition_ends_at,
    oldest_partition_starts_at:
      starts.length > 0 ? new Date(Math.min(...starts)).toISOString() : null,
    retention_days: table.retentionDays,
    runway_ok: !judged || runway.runway_ok,
    lookahead_ok:
      !judged || unbounded || (days !== null && days >= LOOKAHEAD_MIN_DAYS),
    detach_pending: rows.filter((row) => row.detach_pending).length,
    stuck: ranged
      .filter(({ range }) => range !== null && range.to <= stuckBy)
      .map(({ row }) => row.relname)
      .sort(),
    owner_ok: parent !== null && parent.owned && rows.every((row) => row.owned),
  };
}

/**
 * Every registered table's partitions, from the catalog, in one statement:
 * the bounds, the pending detaches and whether trajetto_partitions owns
 * each one. A registered table that does not exist reads as having no
 * partition, which is what it means for an insert.
 */
async function readPartitionStates(
  now: Date = new Date(),
  tables: readonly PartitionedTable[] = registeredPartitions(),
): Promise<Record<string, PartitionTableMetrics>> {
  const rows = await database.$queryRawUnsafe<
    Array<{
      parent: string;
      parent_owned: boolean;
      relname: string | null;
      bound: string | null;
      detach_pending: boolean | null;
      owned: boolean;
    }>
  >(
    `SELECT t.name AS parent,
            coalesce(p.relowner = r.oid, false) AS parent_owned,
            c.relname::text AS relname,
            pg_get_expr(c.relpartbound, c.oid) AS bound,
            i.inhdetachpending AS detach_pending,
            coalesce(c.relowner = r.oid, false) AS owned
       FROM unnest($1::text[]) AS t(name)
       JOIN pg_class p ON p.oid = to_regclass(quote_ident(t.name))
       LEFT JOIN pg_roles r ON r.rolname = $2
       LEFT JOIN pg_inherits i ON i.inhparent = p.oid
       LEFT JOIN pg_class c ON c.oid = i.inhrelid`,
    tables.map((table) => table.table),
    PARTITION_OWNER_ROLE,
  );

  return Object.fromEntries(
    tables.map((table) => {
      const own = rows.filter((row) => row.parent === table.table);
      const parent = own.length > 0 ? { owned: own[0].parent_owned } : null;
      const partitions = own
        .filter((row) => row.relname !== null)
        .map((row) => ({
          relname: row.relname as string,
          bound: row.bound,
          detach_pending: row.detach_pending === true,
          owned: row.owned,
        }));

      return [table.table, partitionTableState(table, parent, partitions, now)];
    }),
  );
}

/**
 * The shape /health/metrics had before the registry, kept as the
 * `driver_position` alias for one release: the web's Sistema screen reads
 * it (trajetto-ui, system-metrics).
 */
function legacyRunway(
  state: PartitionTableMetrics | undefined,
): PartitionRunway {
  if (!state) return partitionRunway([]);

  return {
    partition_runway_days: state.lookahead_days,
    last_partition_ends_at: state.last_partition_ends_at,
    runway_ok: state.runway_ok,
  };
}

export {
  HEARTBEAT_VISIBLE_MS,
  LOOKAHEAD_MIN_DAYS,
  PARTITION_STUCK_GRACE_DAYS,
  RUNWAY_MIN_DAYS,
  legacyRunway,
  partitionRunway,
  partitionTableState,
  readCronJobs,
  readPartitionStates,
  readWorkerHeartbeats,
};
export type {
  CronJobMetrics,
  PartitionCatalogRow,
  PartitionRunway,
  PartitionTableMetrics,
  WorkerMetrics,
};
