import { RedisConnection } from "@/../infra/cache/redis-connection";

import { env } from "@/env";
import type { OperationalSnapshot } from "@/shared/health/alert-rules";
import {
  collectDatabaseMetrics,
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
 * Fail-open, like the process rows: the ping went first, and a read or a
 * write that fails here is a warning, never a failed heartbeat. Off with
 * OPS_SAMPLE_ENABLED=false, as the rest of the series. Infra numbers only.
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

interface ClusterSampleDeps {
  enabled: boolean;
  identity: OpsSampleIdentity;
  readDatabase: (withSizes: boolean) => Promise<DatabaseMetrics>;
  readRedis: () => Promise<RedisMetrics>;
  write: (row: OpsSampleRow) => Promise<void>;
}

function defaultDeps(): ClusterSampleDeps {
  return {
    enabled: env.OPS_SAMPLE_ENABLED,
    identity: opsSampleIdentity(env.WORKERS_ENABLED),
    readDatabase: (withSizes) =>
      collectDatabaseMetrics({ sizes: withSizes ? "fresh" : "skip" }),
    readRedis: () =>
      readRedisMetrics(() => RedisConnection.getInstance().getClient()),
    write: insertOpsSample,
  };
}

/**
 * Reads what the snapshot lacks (the database's own numbers, Redis) and
 * writes the row. Never throws: the heartbeat already did its job.
 */
async function recordClusterSample(
  slot: Date,
  snapshot: OperationalSnapshot,
  deps: Partial<ClusterSampleDeps> = {},
): Promise<void> {
  const { enabled, identity, readDatabase, readRedis, write } = {
    ...defaultDeps(),
    ...deps,
  };

  if (!enabled) return;

  try {
    // One after the other: the heartbeat never takes more than one slot of
    // the pool it watches. Redis is not the pool, but it waits its turn too.
    const database = await readDatabase(carriesSizes(slot));
    const redis = await readRedis();

    await write(
      buildClusterSampleRow({ slot, identity, snapshot, database, redis }),
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
  buildClusterSampleRow,
  carriesSizes,
  recordClusterSample,
};
