import type { Prisma } from "@prisma/client";

import database from "@/../infra/database";
import { sqlStateOf } from "@/shared/errors/prisma-error-meta";
import { logger } from "@/shared/logging/logger";
import { deadTuplePercent } from "@/shared/health/metrics-math";
import {
  DATABASE_PARAMETERS,
  databaseCoreSql,
  databaseSizesSql,
  databaseWalSql,
  latestClusterDatabaseSql,
} from "@/shared/health/metrics-queries";
import {
  pgStatStatementsStateFromCatalog,
  type PgStatStatementsState,
} from "@/shared/health/pg-stat-statements-state";

const log = logger.child({ component: "database-metrics" });

/**
 * The database's own numbers on /health/metrics (plano-escala F1-06): what
 * the alerts of the plan read (archiver, xid, the oldest write, pg_wal) and
 * what a capacity reading compares (hit ratio, the hot tables, the sizes,
 * the parameters, pg_stat_statements).
 *
 * Three reads, one after the other, so the endpoint still takes one slot of
 * the pool at a time:
 *  1. one statement with everything that is cheap (databaseCoreSql);
 *  2. pg_wal, only when the first says this user may list it;
 *  3. the sizes, cached here for five minutes (pg_database_size walks the
 *     data directory).
 *
 * Everything is nullable, and a part that fails is a `collection_errors`
 * entry with its SQLSTATE while the others still answer: the screen opened
 * during an incident must not go blank because one view refused. Nothing
 * here throws.
 *
 * The five-minute copy of the sizes is the plan's own (F1-06), per replica
 * and in memory: platform numbers only a MASTER reads, never tenant data,
 * never Redis.
 */

/** How long the sizes are served before the next read (F1-06). */
const DATABASE_SIZES_TTL_MS = 5 * 60 * 1000;

type DatabaseMetricsPart = "core" | "pg_wal" | "sizes";

interface DatabaseCollectionError {
  part: DatabaseMetricsPart;

  /** The SQLSTATE when Postgres refused; null for anything else. */
  code: string | null;
}

interface HotTableStats {
  table: string;
  partitions: number;
  n_live_tup: number;
  n_dead_tup: number;
  dead_tuple_percent: number;
  last_autovacuum: string | null;
}

interface DatabaseSizes {
  database_bytes: number | null;
  tables: Array<{ table: string; total_bytes: number }>;

  /** When the copy was read: up to five minutes old. */
  measured_at: string;
}

type DatabaseParameter = (typeof DATABASE_PARAMETERS)[number];

interface DatabaseMetrics {
  xid_age: number | null;
  xid_age_database: number | null;
  mxid_age: number | null;
  cache_hit_ratio: number | null;
  blocks_hit: number | null;
  blocks_read: number | null;
  oldest_write_xact_seconds: number | null;
  oldest_snapshot_seconds: number | null;
  oldest_snapshot_xmin_age: number | null;
  stats_cluster_wide: boolean | null;
  archiver: {
    archived_count: number | null;
    failed_count: number | null;
    last_archived_at: string | null;
    last_archived_age_seconds: number | null;
    last_failed_at: string | null;
  } | null;
  hot_tables: HotTableStats[] | null;
  parameters: Record<DatabaseParameter, string | null> | null;
  pg_stat_statements: PgStatStatementsState | null;
  pg_wal: {
    readable: boolean | null;
    files: number | null;
    bytes: number | null;
  };
  sizes: DatabaseSizes | null;
  collection_errors: DatabaseCollectionError[];

  /**
   * When the parts this login may not read came from the cron's newest
   * cluster sample instead (withClusterSample); absent when all is live.
   */
  sampled_at?: string | null;
}

interface DatabaseCoreRow {
  xid_age: number | null;
  xid_age_database: number | null;
  mxid_age: number | null;
  blocks_hit: number | null;
  blocks_read: number | null;
  oldest_write_xact_seconds: number | null;
  oldest_snapshot_seconds: number | null;
  oldest_snapshot_xmin_age: number | null;
  archived_count: number | null;
  archive_failed_count: number | null;
  last_archived_at: Date | string | null;
  last_archived_age_seconds: number | null;
  last_archive_failed_at: Date | string | null;
  hot_tables: Array<{
    table_name: string;
    partitions: number;
    n_live_tup: number;
    n_dead_tup: number;
    last_autovacuum: string | null;
  }> | null;
  parameters: Record<string, string | null> | null;
  pgss_installed: boolean | null;
  stats_cluster_wide: boolean | null;
  wal_readable: boolean | null;
}

interface DatabaseWalRow {
  files: number;
  bytes: number;
}

interface DatabaseSizesRow {
  database_bytes: number | null;
  tables: Array<{ table_name: string; total_bytes: number }> | null;
}

type Client = Pick<Prisma.TransactionClient, "$queryRaw">;

/** A finite number or null: never NaN, never a string from a driver. */
function finiteOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;

  const number = Number(value);

  return Number.isFinite(number) ? number : null;
}

/** An age read across a clock step is never negative. */
function ageOrNull(value: unknown): number | null {
  const number = finiteOrNull(value);

  return number === null ? null : Math.max(0, number);
}

function isoOrNull(value: Date | string | null | undefined): string | null {
  if (!value) return null;

  const date = value instanceof Date ? value : new Date(value);

  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** hit / (hit + read), four places; null before the first block is read. */
function cacheHitRatio(hit: number | null, read: number | null): number | null {
  if (hit === null || read === null || hit + read === 0) return null;

  return Math.round((hit / (hit + read)) * 10_000) / 10_000;
}

function parametersOf(
  raw: Record<string, string | null> | null,
): Record<DatabaseParameter, string | null> | null {
  if (!raw) return null;

  return Object.fromEntries(
    DATABASE_PARAMETERS.map((name) => [name, raw[name] ?? null]),
  ) as Record<DatabaseParameter, string | null>;
}

/**
 * pg_stat_statements' state from the catalog; null when unknown. The
 * preload list is readable only with pg_read_all_settings: without it the
 * row carries no shared_preload_libraries, and an installed extension is
 * unknown, not "not_loaded" (the cron's sample says, F3-18).
 */
function pgssStateOf(
  row: DatabaseCoreRow | undefined,
): PgStatStatementsState | null {
  if (!row || row.pgss_installed === null) return null;

  const preload = row.parameters?.shared_preload_libraries;

  if (row.pgss_installed && (preload === null || preload === undefined)) {
    return null;
  }

  return pgStatStatementsStateFromCatalog({
    installed: row.pgss_installed,
    sharedPreloadLibraries: preload,
  });
}

function coreOf(
  row: DatabaseCoreRow | undefined,
): Omit<DatabaseMetrics, "pg_wal" | "sizes" | "collection_errors"> {
  const blocksHit = finiteOrNull(row?.blocks_hit);
  const blocksRead = finiteOrNull(row?.blocks_read);

  return {
    xid_age: finiteOrNull(row?.xid_age),
    xid_age_database: finiteOrNull(row?.xid_age_database),
    mxid_age: finiteOrNull(row?.mxid_age),
    cache_hit_ratio: cacheHitRatio(blocksHit, blocksRead),
    blocks_hit: blocksHit,
    blocks_read: blocksRead,
    oldest_write_xact_seconds: ageOrNull(row?.oldest_write_xact_seconds),
    oldest_snapshot_seconds: ageOrNull(row?.oldest_snapshot_seconds),
    oldest_snapshot_xmin_age: finiteOrNull(row?.oldest_snapshot_xmin_age),
    stats_cluster_wide: row?.stats_cluster_wide ?? null,
    archiver: row
      ? {
          archived_count: finiteOrNull(row.archived_count),
          failed_count: finiteOrNull(row.archive_failed_count),
          last_archived_at: isoOrNull(row.last_archived_at),
          last_archived_age_seconds: ageOrNull(row.last_archived_age_seconds),
          last_failed_at: isoOrNull(row.last_archive_failed_at),
        }
      : null,
    hot_tables: row?.hot_tables
      ? row.hot_tables.map((table) => {
          const live = finiteOrNull(table.n_live_tup) ?? 0;
          const dead = finiteOrNull(table.n_dead_tup) ?? 0;

          return {
            table: table.table_name,
            partitions: finiteOrNull(table.partitions) ?? 0,
            n_live_tup: live,
            n_dead_tup: dead,
            dead_tuple_percent: deadTuplePercent(live, dead),
            last_autovacuum: isoOrNull(table.last_autovacuum),
          };
        })
      : null,
    parameters: parametersOf(row?.parameters ?? null),
    pg_stat_statements: pgssStateOf(row),
  };
}

function sizesOf(row: DatabaseSizesRow | undefined, at: Date): DatabaseSizes {
  return {
    database_bytes: finiteOrNull(row?.database_bytes),
    tables: (row?.tables ?? []).map((table) => ({
      table: table.table_name,
      total_bytes: finiteOrNull(table.total_bytes) ?? 0,
    })),
    measured_at: at.toISOString(),
  };
}

interface TimedMemo<T> {
  /** The copy while it is younger than the TTL; otherwise reads again. */
  read(compute: () => Promise<T>): Promise<T>;
  reset(): void;
}

/**
 * One value, kept `ttlMs` from when it was computed. A failure is not kept:
 * the next read tries again, so a refusal never sticks for five minutes.
 */
function createTimedMemo<T>({
  ttlMs,
  now = Date.now,
}: {
  ttlMs: number;
  now?: () => number;
}): TimedMemo<T> {
  let copy: { value: T; at: number } | null = null;

  return {
    async read(compute) {
      if (copy && now() - copy.at < ttlMs) return copy.value;

      const value = await compute();

      copy = { value, at: now() };

      return value;
    },
    reset() {
      copy = null;
    },
  };
}

const sizesMemo = createTimedMemo<DatabaseSizes>({
  ttlMs: DATABASE_SIZES_TTL_MS,
});

async function readDatabaseSizes(
  client: Client = database,
  now: () => Date = () => new Date(),
): Promise<DatabaseSizes> {
  const [row] = await client.$queryRaw<DatabaseSizesRow[]>(databaseSizesSql());

  return sizesOf(row, now());
}

function failure(
  part: DatabaseMetricsPart,
  error: unknown,
): DatabaseCollectionError {
  const code = sqlStateOf(error) ?? null;

  log.warn({ err: error, part, code }, "database metrics part failed");

  return { part, code };
}

/**
 * The three reads. `sizes` picks where the sizes come from: the five-minute
 * copy (the endpoint), a fresh read (the cluster row every 15 minutes,
 * F1-10) or none.
 */
async function collectDatabaseMetrics({
  client = database,
  sizes = "cached",
}: {
  client?: Client;
  sizes?: "cached" | "fresh" | "skip";
} = {}): Promise<DatabaseMetrics> {
  const errors: DatabaseCollectionError[] = [];

  let core: DatabaseCoreRow | undefined;

  try {
    [core] = await client.$queryRaw<DatabaseCoreRow[]>(databaseCoreSql());
  } catch (error) {
    errors.push(failure("core", error));
  }

  // Unknown without the first read: neither readable nor refused.
  const walReadable = core ? Boolean(core.wal_readable) : null;
  const pgWal: DatabaseMetrics["pg_wal"] = {
    readable: walReadable,
    files: null,
    bytes: null,
  };

  if (walReadable) {
    try {
      const [wal] = await client.$queryRaw<DatabaseWalRow[]>(databaseWalSql());

      pgWal.files = finiteOrNull(wal?.files);
      pgWal.bytes = finiteOrNull(wal?.bytes);
    } catch (error) {
      errors.push(failure("pg_wal", error));
    }
  }

  let databaseSizes: DatabaseSizes | null = null;

  if (sizes !== "skip") {
    try {
      databaseSizes =
        sizes === "fresh"
          ? await readDatabaseSizes(client)
          : await sizesMemo.read(() => readDatabaseSizes(client));
    } catch (error) {
      errors.push(failure("sizes", error));
    }
  }

  return {
    ...coreOf(core),
    pg_wal: pgWal,
    sizes: databaseSizes,
    collection_errors: errors,
  };
}

/**
 * How old the cron's cluster sample may be and still stand in for a live
 * read: the row is written every minute, so five is a heartbeat that
 * missed a few, not one that stopped.
 */
const CLUSTER_SAMPLE_MAX_AGE_MS = 5 * 60 * 1000;

interface ClusterDatabaseSample {
  ts: Date;
  database: {
    stats_cluster_wide?: boolean | null;
    oldest_write_xact_seconds?: number | null;
    oldest_snapshot_seconds?: number | null;
    oldest_snapshot_xmin_age?: number | null;
    pg_wal?: DatabaseMetrics["pg_wal"] | null;
    pg_stat_statements?: PgStatStatementsState | null;
  } | null;
}

/**
 * The live reading, with what this login may not see taken from the cron's
 * newest cluster sample (plano-escala F3-18). Pure.
 *
 * After the cut of the database roles the runtime connects as
 * trajetto_http, which has neither pg_read_all_stats (the other roles'
 * sessions come back without xact_start, backend_xid and backend_xmin, so
 * the oldest write and the oldest snapshot read null) nor pg_monitor
 * (pg_ls_waldir is refused), nor pg_read_all_settings (the preload list,
 * so pg_stat_statements' state is unknown). The process with the cron reads them on the
 * maintenance pool, as trajetto_batch, into the cluster row of every
 * minute; this reads that row instead of answering null. Only the parts
 * this login could not read are replaced, only from a sample that could,
 * and only from a recent one; `sampled_at` says when it was read. With a
 * superuser, as today, nothing changes.
 */
function mergeClusterSample(
  live: DatabaseMetrics,
  sample: ClusterDatabaseSample | null,
  now: Date = new Date(),
): DatabaseMetrics {
  if (!sample?.database) return live;
  if (now.getTime() - sample.ts.getTime() > CLUSTER_SAMPLE_MAX_AGE_MS) {
    return live;
  }

  const sampled = sample.database;
  const sessions =
    live.stats_cluster_wide === false && sampled.stats_cluster_wide === true;
  const wal =
    live.pg_wal.readable === false && sampled.pg_wal?.readable === true;
  const pgss =
    live.pg_stat_statements === null &&
    sampled.pg_stat_statements !== null &&
    sampled.pg_stat_statements !== undefined;

  if (!sessions && !wal && !pgss) return live;

  return {
    ...live,
    ...(sessions && {
      oldest_write_xact_seconds: ageOrNull(sampled.oldest_write_xact_seconds),
      oldest_snapshot_seconds: ageOrNull(sampled.oldest_snapshot_seconds),
      oldest_snapshot_xmin_age: finiteOrNull(sampled.oldest_snapshot_xmin_age),
      stats_cluster_wide: true,
    }),
    ...(wal &&
      sampled.pg_wal && {
        pg_wal: {
          readable: true,
          files: finiteOrNull(sampled.pg_wal.files),
          bytes: finiteOrNull(sampled.pg_wal.bytes),
        },
      }),
    ...(pgss && { pg_stat_statements: sampled.pg_stat_statements }),
    sampled_at: sample.ts.toISOString(),
  };
}

/**
 * The live reading, completed from the cron's sample when this login may
 * not read everything (mergeClusterSample). One more statement only then;
 * a sample that cannot be read leaves the live reading as it is.
 */
async function withClusterSample(
  live: DatabaseMetrics,
  client: Client = database,
  now: Date = new Date(),
): Promise<DatabaseMetrics> {
  if (
    live.stats_cluster_wide !== false &&
    live.pg_wal.readable !== false &&
    live.pg_stat_statements !== null
  ) {
    return live;
  }

  try {
    const [sample] = await client.$queryRaw<ClusterDatabaseSample[]>(
      latestClusterDatabaseSql(
        new Date(now.getTime() - CLUSTER_SAMPLE_MAX_AGE_MS),
      ),
    );

    return mergeClusterSample(
      live,
      sample ? { ...sample, ts: new Date(sample.ts) } : null,
      now,
    );
  } catch (error) {
    log.warn({ err: error }, "cluster sample read failed");

    return live;
  }
}

/** For tests: the next cached read goes to the database again. */
function resetDatabaseSizesCache(): void {
  sizesMemo.reset();
}

export {
  CLUSTER_SAMPLE_MAX_AGE_MS,
  DATABASE_SIZES_TTL_MS,
  cacheHitRatio,
  collectDatabaseMetrics,
  createTimedMemo,
  mergeClusterSample,
  readDatabaseSizes,
  resetDatabaseSizesCache,
  withClusterSample,
};
export type {
  ClusterDatabaseSample,
  DatabaseCollectionError,
  DatabaseMetrics,
  DatabaseSizes,
  HotTableStats,
};
