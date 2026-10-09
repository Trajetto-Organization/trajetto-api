/**
 * The Prisma connection pool of THIS replica, read from `$metrics.json()`
 * (OBS-11, GAP3-10; `previewFeatures = ["metrics"]` in schema.prisma).
 *
 * The pool is what saturates first under load: every request and worker of a
 * replica shares `connection_limit` connections, and a request that finds
 * them all busy waits up to pool_timeout before failing. Postgres' own
 * pg_stat_activity/max_connections cannot show it — two replicas of ten
 * against a hundred read 20% while both pools are full.
 */

interface MetricEntry {
  key: string;
  value: unknown;
}

interface PrismaMetricsJson {
  counters: MetricEntry[];
  gauges: MetricEntry[];
  histograms: MetricEntry[];
}

interface PoolMetrics {
  /** Connections the pool holds open. */
  open: number;

  /** Of those, running a query right now. */
  busy: number;

  idle: number;

  /** Queries waiting for a free connection right now: saturation. */
  waiting: number;
}

function gauge(metrics: PrismaMetricsJson, key: string): number {
  const value = metrics.gauges.find((entry) => entry.key === key)?.value;

  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Zero for a gauge the running Prisma version does not report: the metrics
 * preview renames things between releases, and a missing gauge must not turn
 * the endpoint into a 500.
 */
function poolFromMetrics(metrics: PrismaMetricsJson): PoolMetrics {
  return {
    open: gauge(metrics, "prisma_pool_connections_open"),
    busy: gauge(metrics, "prisma_pool_connections_busy"),
    idle: gauge(metrics, "prisma_pool_connections_idle"),
    waiting: gauge(metrics, "prisma_client_queries_wait"),
  };
}

/**
 * `connection_limit` of a database URL, or null when the URL leaves it to
 * Prisma's default (a function of the CPU count).
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

interface MetricsSource {
  $metrics: { json(): Promise<PrismaMetricsJson> };
}

/**
 * The pool of the client given (the application's), with the limit read from
 * its URL: `runtime.prisma_pool` of the minute log line (runtime-metrics.ts).
 */
async function readPrismaPool(
  source: MetricsSource,
  databaseUrl: string | undefined,
): Promise<PoolMetrics & { limit: number | null }> {
  return {
    limit: connectionLimitOf(databaseUrl),
    ...poolFromMetrics(await source.$metrics.json()),
  };
}

export { connectionLimitOf, poolFromMetrics, readPrismaPool };
export type { PoolMetrics, PrismaMetricsJson };
