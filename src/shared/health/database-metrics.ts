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
    pg_stat_statements:
      row && row.pgss_installed !== null
        ? pgStatStatementsStateFromCatalog({
            installed: row.pgss_installed,
            sharedPreloadLibraries:
              row.parameters?.shared_preload_libraries ?? null,
          })
        : null,
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

/** For tests: the next cached read goes to the database again. */
function resetDatabaseSizesCache(): void {
  sizesMemo.reset();
}

export {
  DATABASE_SIZES_TTL_MS,
  cacheHitRatio,
  collectDatabaseMetrics,
  createTimedMemo,
  readDatabaseSizes,
  resetDatabaseSizesCache,
};
export type {
  DatabaseCollectionError,
  DatabaseMetrics,
  DatabaseSizes,
  HotTableStats,
};
