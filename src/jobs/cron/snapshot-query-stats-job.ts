import { Prisma } from "@prisma/client";

import database from "@/../infra/database";
import { env } from "@/env";
import { readPgStatStatementsState } from "@/shared/health/pg-stat-statements-state";
import {
  diffStatements,
  type BaselineCounters,
  type StatementCounters,
  type StatementDelta,
} from "@/shared/health/pgss-diff";
import { logger } from "@/shared/logging/logger";
import type {
  CronJobDefinition,
  CronRun,
} from "@/shared/services/cron-scheduler-service";

/**
 * The hourly cost of the top statements (plano-escala F1-12).
 *
 * The scale plan's triggers (the standby reads at 20% of the primary's
 * total_exec_time, the http role's statement_timeout dropping to 10 s once
 * no statement's max_exec_time passes it, the CPU of the primary) are
 * judged on pg_stat_statements. The view is cumulative, so once an hour,
 * at :13 (clear of the :07 sweeps and the nightly purges' minutes), the
 * elected replica:
 *
 *  1. reads every statement of THIS database without the text (the view is
 *     the whole cluster's; a second database on the server is not ours);
 *  2. subtracts the baseline the previous run left (pgss-diff.ts handles a
 *     reset, an eviction and the cumulative maximum), keeps the top
 *     PGSS_SNAPSHOT_TOP (200) by execution time in the hour, and reads
 *     only their texts;
 *  3. in one transaction, writes those rows to pgss_snapshot, replaces the
 *     baseline with this reading and records stats_reset and dealloc in
 *     pgss_state.
 *
 * The first run (no state yet) and a run after a reset write the view's
 * counters as they are, since the reset (basis "reset", period from
 * stats_reset); from the second run on, each row is one hour's growth.
 *
 * Until the server preloads the library (production: the new Postgres image
 * of wave 3) the state is not "ready" and the run is a no-op with a warning,
 * never a failure: a missing measurement must not page as a broken job.
 *
 * The query texts may carry literals: they stay in pgss_snapshot, read with
 * psql, and no route serves them (docs/deploy.md, Séries de operação).
 */
const SNAPSHOT_QUERY_STATS_JOB = "snapshot-query-stats";

const log = logger.child({ component: "cron", job: SNAPSHOT_QUERY_STATS_JOB });

/** Enough of a statement to recognise it; the rest is pg_stat_statements'. */
const QUERY_TEXT_MAX_CHARS = 4_096;

/** Rows per INSERT: far below Postgres' 65.535 parameters at 18 columns. */
const INSERT_CHUNK_ROWS = 1_000;

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

type Client = Pick<typeof database, "$queryRaw">;

interface PgssInfo {
  dealloc: number;
  stats_reset: Date | null;
}

interface QueryText {
  userid: string;
  toplevel: boolean;
  queryid: string;
  query: string | null;
}

interface SnapshotOutcome {
  written: number;
  active: number;
  statements: number;
  recreated: number;
  vanished: number;

  /** Entries the view threw away since the previous run (dealloc grew). */
  evicted: number;
  reset: boolean;
}

/** The schema the extension went into: called by its qualified name. */
async function extensionSchema(client: Client): Promise<Prisma.Sql> {
  const [extension] = await client.$queryRaw<Array<{ schema: string }>>`
    SELECT n.nspname AS schema
    FROM pg_extension e
    JOIN pg_namespace n ON n.oid = e.extnamespace
    WHERE e.extname = 'pg_stat_statements'
  `;

  if (!extension) throw new Error("pg_stat_statements is not installed");

  return Prisma.raw(quoteIdent(extension.schema));
}

/** This database's oid: the view lists every database of the server. */
const THIS_DATABASE = Prisma.sql`(
  SELECT oid FROM pg_database WHERE datname = current_database()
)`;

async function readInfo(client: Client, schema: Prisma.Sql): Promise<PgssInfo> {
  // To the millisecond, as pgss_state keeps it: a microsecond the column
  // dropped would read as a reset every hour.
  const [info] = await client.$queryRaw<PgssInfo[]>`
    SELECT
      dealloc::float8 AS dealloc,
      date_trunc('milliseconds', stats_reset) AS stats_reset
    FROM ${schema}.pg_stat_statements_info
  `;

  return {
    dealloc: info?.dealloc ?? 0,
    stats_reset: info?.stats_reset ?? null,
  };
}

/**
 * Every statement of this database, counters only. queryid is null for
 * another role's statements without pg_read_all_stats: nothing to key on.
 */
async function readStatements(
  client: Client,
  schema: Prisma.Sql,
): Promise<StatementCounters[]> {
  return client.$queryRaw<StatementCounters[]>`
    SELECT
      s.userid::text AS userid,
      s.toplevel,
      s.queryid::text AS queryid,
      s.calls::float8 AS calls,
      s.total_exec_time,
      s.total_plan_time,
      s.max_exec_time,
      s.rows::float8 AS rows,
      s.shared_blks_hit::float8 AS shared_blks_hit,
      s.shared_blks_read::float8 AS shared_blks_read,
      s.shared_blks_dirtied::float8 AS shared_blks_dirtied,
      s.shared_blks_written::float8 AS shared_blks_written,
      s.temp_blks_written::float8 AS temp_blks_written,
      s.wal_bytes::float8 AS wal_bytes
    FROM ${schema}.pg_stat_statements(false) s
    WHERE s.dbid = ${THIS_DATABASE}
      AND s.queryid IS NOT NULL
  `;
}

/** The texts of the chosen statements only: the view reads its text file. */
async function readTexts(
  client: Client,
  schema: Prisma.Sql,
  rows: StatementDelta[],
): Promise<Map<string, string | null>> {
  const texts = new Map<string, string | null>();

  if (rows.length === 0) return texts;

  const ids = [...new Set(rows.map((row) => row.queryid))];
  const found = await client.$queryRaw<QueryText[]>`
    SELECT
      s.userid::text AS userid,
      s.toplevel,
      s.queryid::text AS queryid,
      left(s.query, ${QUERY_TEXT_MAX_CHARS}) AS query
    FROM ${schema}.pg_stat_statements(true) s
    WHERE s.dbid = ${THIS_DATABASE}
      AND s.queryid = ANY(${ids}::bigint[])
  `;

  for (const row of found) {
    texts.set(`${row.userid}:${row.toplevel}:${row.queryid}`, row.query);
  }

  return texts;
}

async function readBaseline(client: Client): Promise<BaselineCounters[]> {
  return client.$queryRaw<BaselineCounters[]>`
    SELECT
      userid::text AS userid,
      toplevel,
      queryid::text AS queryid,
      calls::float8 AS calls,
      total_exec_time_ms AS total_exec_time,
      total_plan_time_ms AS total_plan_time,
      rows::float8 AS rows,
      shared_blks_hit::float8 AS shared_blks_hit,
      shared_blks_read::float8 AS shared_blks_read,
      shared_blks_dirtied::float8 AS shared_blks_dirtied,
      shared_blks_written::float8 AS shared_blks_written,
      temp_blks_written::float8 AS temp_blks_written,
      wal_bytes::float8 AS wal_bytes
    FROM pgss_baseline
  `;
}

/** Entries the view threw away between two runs; 0 when unknown. */
function evictedSince(previous: number | null, now: number): number {
  return previous === null ? 0 : Math.max(0, now - previous);
}

/** A counter as the BIGINT column takes it. */
const big = (value: number) => BigInt(Math.max(0, Math.round(value)));

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];

  for (let start = 0; start < items.length; start += size) {
    out.push(items.slice(start, start + size));
  }

  return out;
}

/**
 * One snapshot at `takenAt`. Throws when the database does not answer: the
 * run is FAILED, and the next hour starts from the baseline it left.
 */
async function snapshotQueryStats({
  takenAt,
  top = env.PGSS_SNAPSHOT_TOP,
}: {
  takenAt: Date;
  top?: number;
}): Promise<SnapshotOutcome> {
  const schema = await extensionSchema(database);
  const info = await readInfo(database, schema);
  const current = await readStatements(database, schema);
  const state = await database.pgssState.findUnique({ where: { id: 1 } });
  const baseline = state ? await readBaseline(database) : [];

  // No state is the first run; a stats_reset that moved is a reset. Either
  // way the view's counters are what happened since stats_reset.
  const reset =
    !state ||
    (state.stats_reset?.getTime() ?? null) !==
      (info.stats_reset?.getTime() ?? null);

  const diff = diffStatements({ current, baseline, reset, top });
  const texts = await readTexts(database, schema, diff.top);
  const periodStart = (reset ? info.stats_reset : state?.taken_at) ?? takenAt;

  // dealloc counts from the last reset: across one, the run cannot tell.
  const previousDealloc = state && !reset ? Number(state.dealloc) : null;

  await database.$transaction(async (tx) => {
    for (const chunk of chunks(diff.top, INSERT_CHUNK_ROWS)) {
      await tx.pgssSnapshot.createMany({
        data: chunk.map((row) => ({
          taken_at: takenAt,
          period_start: periodStart,
          basis: row.basis,
          userid: BigInt(row.userid),
          toplevel: row.toplevel,
          queryid: BigInt(row.queryid),
          query: texts.get(`${row.userid}:${row.toplevel}:${row.queryid}`),
          calls: big(row.calls),
          total_exec_time_ms: row.total_exec_time,
          total_plan_time_ms: row.total_plan_time,
          max_exec_time_ms: row.max_exec_time,
          rows: big(row.rows),
          shared_blks_hit: big(row.shared_blks_hit),
          shared_blks_read: big(row.shared_blks_read),
          shared_blks_dirtied: big(row.shared_blks_dirtied),
          shared_blks_written: big(row.shared_blks_written),
          temp_blks_written: big(row.temp_blks_written),
          wal_bytes: big(row.wal_bytes),
        })),
      });
    }

    await tx.pgssBaseline.deleteMany({});

    for (const chunk of chunks(current, INSERT_CHUNK_ROWS)) {
      await tx.pgssBaseline.createMany({
        data: chunk.map((entry) => ({
          userid: BigInt(entry.userid),
          toplevel: entry.toplevel,
          queryid: BigInt(entry.queryid),
          calls: big(entry.calls),
          total_exec_time_ms: entry.total_exec_time,
          total_plan_time_ms: entry.total_plan_time,
          rows: big(entry.rows),
          shared_blks_hit: big(entry.shared_blks_hit),
          shared_blks_read: big(entry.shared_blks_read),
          shared_blks_dirtied: big(entry.shared_blks_dirtied),
          shared_blks_written: big(entry.shared_blks_written),
          temp_blks_written: big(entry.temp_blks_written),
          wal_bytes: big(entry.wal_bytes),
        })),
      });
    }

    const recorded = {
      taken_at: takenAt,
      stats_reset: info.stats_reset,
      dealloc: big(info.dealloc),
      statements: current.length,
    };

    await tx.pgssState.upsert({
      where: { id: 1 },
      create: { id: 1, ...recorded },
      update: recorded,
    });
  });

  return {
    written: diff.top.length,
    active: diff.active,
    statements: current.length,
    recreated: diff.recreated,
    vanished: diff.vanished,
    evicted: evictedSince(previousDealloc, info.dealloc),
    reset,
  };
}

interface SnapshotJobDeps {
  readState: typeof readPgStatStatementsState;
  snapshot: typeof snapshotQueryStats;
}

function snapshotQueryStatsHandler({
  readState = readPgStatStatementsState,
  snapshot = snapshotQueryStats,
}: Partial<SnapshotJobDeps> = {}): (run?: CronRun) => Promise<void> {
  return async (run) => {
    const state = await readState();

    if (state !== "ready") {
      log.warn(
        { state },
        "query stats snapshot skipped: pg_stat_statements is not ready",
      );
      return;
    }

    const outcome = await snapshot({
      takenAt: run?.scheduledFor ?? new Date(),
    });

    // Evictions undercount the hour of the statements that re-entered: the
    // way out is a larger pg_stat_statements.max, not a quieter log.
    if (outcome.evicted > 0) {
      log.warn(
        outcome,
        "pg_stat_statements evicted entries since the last snapshot",
      );
    } else {
      log.info(outcome, "query stats snapshot written");
    }
  };
}

const snapshotQueryStatsJob: CronJobDefinition = {
  name: SNAPSHOT_QUERY_STATS_JOB,
  schedule: "13 * * * *",
  handler: snapshotQueryStatsHandler(),
};

export {
  SNAPSHOT_QUERY_STATS_JOB,
  snapshotQueryStats,
  snapshotQueryStatsHandler,
  snapshotQueryStatsJob,
};
export type { SnapshotOutcome };
