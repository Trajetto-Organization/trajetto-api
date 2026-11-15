import { RedisConnection } from "@/../infra/cache/redis-connection";
import database from "@/../infra/database";

import { env } from "@/env";
import type { OperationalSnapshot } from "@/shared/health/alert-rules";
import {
  collectDatabaseMetrics,
  type DatabaseCollectionError,
  type DatabaseMetrics,
} from "@/shared/health/database-metrics";
import {
  OPS_SAMPLE_VERSION,
  insertOpsSample,
  opsSampleIdentity,
  type OpsSampleIdentity,
  type OpsSampleRow,
} from "@/shared/health/ops-sample";
import {
  readRedisMetrics,
  type RedisMetrics,
} from "@/shared/health/redis-metrics";
import { logger } from "@/shared/logging/logger";

const log = logger.child({ component: "ops-heartbeat" });

/**
 * The cluster's row of the per-minute series (plano-escala F1-10): one
 * `ops_sample` row a minute with `role = 'cluster'`, written by the replica
 * that won the ops heartbeat's election, after its ping.
 *
 * The process rows (F1-08) say what each process saw; nobody wrote what the
 * CLUSTER looked like: the queues' lags, the archiver, the xid, the oldest
 * write, pg_wal and Redis. Those are one reading for everybody, so one
 * writer a minute: the heartbeat's unique (jobName, scheduledFor) election
 * already picks it, and the row's `ts` is that elected minute, so two
 * replicas firing the same minute still leave one row.
 *
 * It is also the marker row of the PITR drill: a restore to T must hold the
 * cluster row of T's minute.
 *
 * Every 15 minutes (a quarter-hour slot) it also carries the sizes and the
 * hot tables' estimates, read fresh: they move by the day, and the
 * per-minute row stays small. The deliveries created counter of U-12 joins
 * this row when that item lands.
 *
 * The readings are taken once, BEFORE the ping, because the alerts judge
 * them too (F1-11: the archiver, the xid, the oldest write, pg_wal, Redis'
 * memory and evictions); the row is written after it, from the same
 * readings. Evictions are a counter since Redis started, so the alert
 * compares it with the cluster row of about 15 minutes ago.
 *
 * Fail-open, like the process rows: a read that fails is a null (and, for
 * the database's own parts, a reason the alerts report), and a write that
 * fails is a warning, never a failed heartbeat. OPS_SAMPLE_ENABLED=false
 * stops the write, as the rest of the series; the readings still feed the
 * alerts, without the eviction baseline (no rows to compare with). Infra
 * numbers only.
 */

/** Sizes and hot tables ride on the quarter-hour rows. */
const CLUSTER_SIZES_EVERY_MINUTES = 15;

function carriesSizes(slot: Date): boolean {
  return slot.getUTCMinutes() % CLUSTER_SIZES_EVERY_MINUTES === 0;
}

/** The part names of the snapshot's collection errors, never the message. */
function partNames(errors: string[]): string[] {
  return errors.map((error) => error.split(":")[0].trim());
}

/** The database block of the row: what the alerts of the plan read. */
function databaseSection(
  database: DatabaseMetrics,
  connectionUsagePercent: number,
  withSizes: boolean,
): Record<string, unknown> {
  return {
    connection_usage_percent: connectionUsagePercent,
    xid_age: database.xid_age,
    xid_age_database: database.xid_age_database,
    mxid_age: database.mxid_age,
    oldest_write_xact_seconds: database.oldest_write_xact_seconds,
    oldest_snapshot_seconds: database.oldest_snapshot_seconds,
    oldest_snapshot_xmin_age: database.oldest_snapshot_xmin_age,
    stats_cluster_wide: database.stats_cluster_wide,
    blocks_hit: database.blocks_hit,
    blocks_read: database.blocks_read,
    archive_mode: database.parameters?.archive_mode ?? null,
    archiver: database.archiver,
    pg_wal: database.pg_wal,
    pg_stat_statements: database.pg_stat_statements,
    collection_errors: database.collection_errors,
    ...(withSizes
      ? { sizes: database.sizes, hot_tables: database.hot_tables }
      : {}),
  };
}

/** The cluster row of one elected minute. */
function buildClusterSampleRow({
  slot,
  identity,
  snapshot,
  database,
  redis,
}: {
  slot: Date;
  identity: OpsSampleIdentity;
  snapshot: OperationalSnapshot;
  database: DatabaseMetrics;
  redis: RedisMetrics;
}): OpsSampleRow {
  return {
    ts: slot,
    role: "cluster",
    replica: identity.replica,
    commit: identity.commit,
    metrics: {
      v: OPS_SAMPLE_VERSION,
      queues: {
        outbox_eligible_lag_seconds: snapshot.outboxEligibleLagSec,
        delivery_internal_lag_seconds: snapshot.deliveryEligibleLagSec.internal,
        delivery_external_lag_seconds: snapshot.deliveryEligibleLagSec.external,
        webhook_due_lag_seconds: snapshot.webhookDueLagSec,
        ai_eligible_lag_seconds: snapshot.aiEligibleLagSec,
        ai_provider_paused_requests: snapshot.aiProviderPausedRequests ?? null,
        stuck_workers: snapshot.stuckWorkers.length,
        partition_runway_days: snapshot.partitionRunwayDays,
      },
      database: databaseSection(
        database,
        snapshot.connectionUsagePercent,
        carriesSizes(slot),
      ),
      redis,
      collection_errors: partNames(snapshot.collectionErrors),
    },
  };
}

/**
 * The alert compares Redis' eviction counter with the cluster row of this
 * many minutes ago (F1-11).
 */
const EVICTION_WINDOW_MINUTES = 15;

/**
 * A missed minute or two still compares: the newest row up to this much
 * older than the window. Past it, there is no "15 minutes ago" to read.
 */
const EVICTION_BASELINE_SLACK_MINUTES = 5;

/** Redis' counters in the cluster row of about 15 minutes ago. */
interface ClusterBaseline {
  ts: Date;
  evicted_keys: number | null;
  uptime_seconds: number | null;
}

/** What the heartbeat read of the cluster, for the alerts and the row. */
interface ClusterReadings {
  database: DatabaseMetrics;
  redis: RedisMetrics;

  /** Keys evicted since the baseline row; null without one. */
  redisEvictions: { delta: number; windowSec: number } | null;
}

/**
 * The newest 'cluster' row between 15 and 20 minutes before the slot, by
 * the ts index, scanned backwards over a five-minute range (a few rows per
 * minute: one per process plus the cluster's).
 */
async function readEvictionBaseline(
  slot: Date,
): Promise<ClusterBaseline | null> {
  const until = new Date(slot.getTime() - EVICTION_WINDOW_MINUTES * 60_000);
  const from = new Date(
    until.getTime() - EVICTION_BASELINE_SLACK_MINUTES * 60_000,
  );

  const [row] = await database.$queryRaw<ClusterBaseline[]>`
    SELECT
      ts,
      (metrics->'redis'->>'evicted_keys')::float8 AS evicted_keys,
      (metrics->'redis'->>'uptime_seconds')::float8 AS uptime_seconds
    FROM ops_sample
    WHERE ts <= ${until} AND ts > ${from} AND role = 'cluster'
    ORDER BY ts DESC
    LIMIT 1
  `;

  return row ?? null;
}

/**
 * Keys evicted since the baseline row. evicted_keys counts from the
 * server's start: a Redis that restarted after the baseline (up for less
 * than the window, or a counter that went backwards) counts from zero, and
 * everything it holds happened inside the window. Null when there is
 * nothing to compare: no row, no number, or Redis down.
 */
function evictionsSince(
  redis: RedisMetrics,
  baseline: ClusterBaseline | null,
  slot: Date,
): { delta: number; windowSec: number } | null {
  if (redis.status !== "up" || redis.evicted_keys === null) return null;
  if (!baseline || baseline.evicted_keys === null) return null;

  const windowSec = Math.max(
    0,
    Math.round((slot.getTime() - new Date(baseline.ts).getTime()) / 1000),
  );
  const restarted =
    (redis.uptime_seconds !== null && redis.uptime_seconds < windowSec) ||
    redis.evicted_keys < baseline.evicted_keys;

  return {
    delta: restarted
      ? redis.evicted_keys
      : redis.evicted_keys - baseline.evicted_keys,
    windowSec,
  };
}

interface ClusterReadDeps {
  readDatabase: (withSizes: boolean) => Promise<DatabaseMetrics>;
  readRedis: () => Promise<RedisMetrics>;
  readBaseline: (slot: Date) => Promise<ClusterBaseline | null>;
}

function defaultReadDeps(): ClusterReadDeps {
  return {
    readDatabase: (withSizes) =>
      collectDatabaseMetrics({ sizes: withSizes ? "fresh" : "skip" }),
    readRedis: () =>
      readRedisMetrics(() => RedisConnection.getInstance().getClient()),
    readBaseline: readEvictionBaseline,
  };
}

/**
 * The cluster's readings of one elected minute, before the ping. Never
 * throws: the database's metrics and Redis' answer with nulls when they
 * cannot read, and a baseline that cannot be read compares nothing.
 */
async function readClusterReadings(
  slot: Date,
  deps: Partial<ClusterReadDeps> = {},
): Promise<ClusterReadings> {
  const { readDatabase, readRedis, readBaseline } = {
    ...defaultReadDeps(),
    ...deps,
  };

  // One after the other: the heartbeat never takes more than one slot of
  // the pool it watches. Redis is not the pool, but it waits its turn too.
  const databaseMetrics = await readDatabase(carriesSizes(slot));
  const redis = await readRedis();

  let baseline: ClusterBaseline | null = null;

  try {
    baseline = await readBaseline(slot);
  } catch (error) {
    log.warn(
      { err: error, ts: slot.toISOString() },
      "cluster eviction baseline read failed",
    );
  }

  return {
    database: databaseMetrics,
    redis,
    redisEvictions: evictionsSince(redis, baseline, slot),
  };
}

function dateOrNull(value: string | null | undefined): Date | null {
  return value ? new Date(value) : null;
}

/**
 * The database parts whose failure leaves a rule blind: the core statement
 * (archiver, xid, the oldest write) and pg_wal. The sizes are a reading
 * for the series, not for an alert.
 */
const JUDGED_DATABASE_PARTS = new Set(["core", "pg_wal"]);

/** An unread judged part, as the reason the alerts report. */
function unreadParts(errors: DatabaseCollectionError[]): string[] {
  const reasons: string[] = [];

  for (const error of errors) {
    if (!JUDGED_DATABASE_PARTS.has(error.part)) continue;

    const detail = error.code ? `SQLSTATE ${error.code}` : "sem resposta";

    reasons.push(`métricas do banco (${error.part}): ${detail}`);
  }

  return reasons;
}

/**
 * The snapshot the alerts judge: the heartbeat's own reads plus the
 * cluster readings. An unread judged part is a reason ("Verificação
 * incompleta"), as every other part of the snapshot.
 */
function withClusterReadings(
  snapshot: OperationalSnapshot,
  readings: ClusterReadings,
): OperationalSnapshot {
  const { database: metrics, redis } = readings;
  const archiver = metrics.archiver;

  return {
    ...snapshot,
    database: {
      archiveMode: metrics.parameters?.archive_mode ?? null,
      lastArchivedAgeSec: archiver?.last_archived_age_seconds ?? null,
      lastArchivedAt: dateOrNull(archiver?.last_archived_at),
      lastArchiveFailedAt: dateOrNull(archiver?.last_failed_at),
      archiveFailedCount: archiver?.failed_count ?? null,
      xidAge: metrics.xid_age,
      oldestWriteXactSec: metrics.oldest_write_xact_seconds,
      pgWalBytes: metrics.pg_wal.bytes,
    },
    redis: {
      up: redis.status === "up",
      maxmemoryMb: redis.maxmemory_mb,
      maxmemoryPolicy: redis.maxmemory_policy,
      evictedKeys: readings.redisEvictions,
    },
    collectionErrors: [
      ...snapshot.collectionErrors,
      ...unreadParts(metrics.collection_errors),
    ],
  };
}

interface ClusterSampleDeps {
  enabled: boolean;
  identity: OpsSampleIdentity;
  write: (row: OpsSampleRow) => Promise<void>;
}

function defaultDeps(): ClusterSampleDeps {
  return {
    enabled: env.OPS_SAMPLE_ENABLED,
    identity: opsSampleIdentity(env.WORKERS_ENABLED),
    write: insertOpsSample,
  };
}

/**
 * Writes the row from the readings taken before the ping. Never throws:
 * the heartbeat already did its job.
 */
async function recordClusterSample(
  slot: Date,
  snapshot: OperationalSnapshot,
  readings: ClusterReadings,
  deps: Partial<ClusterSampleDeps> = {},
): Promise<void> {
  const { enabled, identity, write } = { ...defaultDeps(), ...deps };

  if (!enabled) return;

  try {
    await write(
      buildClusterSampleRow({
        slot,
        identity,
        snapshot,
        database: readings.database,
        redis: readings.redis,
      }),
    );
  } catch (error) {
    log.warn(
      { err: error, ts: slot.toISOString() },
      "cluster ops sample write failed",
    );
  }
}

export {
  CLUSTER_SIZES_EVERY_MINUTES,
  EVICTION_WINDOW_MINUTES,
  buildClusterSampleRow,
  carriesSizes,
  evictionsSince,
  readClusterReadings,
  readEvictionBaseline,
  recordClusterSample,
  withClusterReadings,
};
export type { ClusterBaseline, ClusterReadings };
