/**
 * The database connection pool of THIS replica (OBS-11, GAP3-10), read from
 * the pg Pool behind Prisma 7's driver adapter.
 *
 * The pool is what saturates first under load: every request and worker of a
 * replica shares `connection_limit` connections, and a request that finds
 * them all busy waits up to pool_timeout before failing. Postgres' own
 * pg_stat_activity/max_connections cannot show it — two replicas of ten
 * against a hundred read 20% while both pools are full.
 *
 * Prisma 6 exposed these numbers through the `metrics` preview
 * (`$metrics.json()`), removed in Prisma 7. pg-pool counts the same things
 * itself; the fields of `runtime.prisma_pool` keep their names and meaning,
 * so the Sistema screen, the minute log line and the alert rules read them
 * as before.
 */

interface PoolMetrics {
  /** Connections the pool holds open. */
  open: number;

  /** Of those, checked out by a query or a transaction right now. */
  busy: number;

  idle: number;

  /** Queries waiting for a free connection right now: saturation. */
  waiting: number;
}

/** What pg-pool exposes, and all this module reads of it. */
interface PoolStats {
  readonly totalCount: number;
  readonly idleCount: number;
  readonly waitingCount: number;
  readonly options: { max?: number };
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

/** Zeros before the first query: the pool is built on first use. */
function poolFromStats(pool: PoolStats | null): PoolMetrics {
  if (!pool) return { open: 0, busy: 0, idle: 0, waiting: 0 };

  const open = count(pool.totalCount);
  const idle = count(pool.idleCount);

  return {
    open,
    busy: Math.max(open - idle, 0),
    idle,
    waiting: count(pool.waitingCount),
  };
}

/**
 * `connection_limit` of a database URL, or null when the URL does not set it
 * (the pool then holds pg's default of 10; see pool-config.ts).
 */
function connectionLimitOf(databaseUrl: string | undefined): number | null {
  if (!databaseUrl) return null;

  try {
    const value = new URL(databaseUrl).searchParams.get("connection_limit");
    const limit = value === null ? NaN : Number(value);

    return Number.isInteger(limit) && limit > 0 ? limit : null;
  } catch {
    return null;
  }
}

/** The pool's own `max` once it exists, the URL's until then. */
function poolLimitOf(
  pool: PoolStats | null,
  databaseUrl: string | undefined,
): number | null {
  const max = pool?.options.max;

  return typeof max === "number" && Number.isInteger(max) && max > 0
    ? max
    : connectionLimitOf(databaseUrl);
}

/**
 * The application's pool with its limit: `runtime.prisma_pool` of the
 * minute log line (runtime-metrics.ts) and of /health/metrics.
 */
async function readPrismaPool(
  source: () => PoolStats | null,
  databaseUrl: string | undefined,
): Promise<PoolMetrics & { limit: number | null }> {
  const pool = source();

  return { limit: poolLimitOf(pool, databaseUrl), ...poolFromStats(pool) };
}

export { connectionLimitOf, poolFromStats, poolLimitOf, readPrismaPool };
export type { PoolMetrics, PoolStats };
