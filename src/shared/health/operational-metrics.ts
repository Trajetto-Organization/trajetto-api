import { container } from "tsyringe";
import { NotificationChannel } from "@prisma/client";

import database, { databasePool } from "@/../infra/database";
import { RedisConnection } from "@/../infra/cache/redis-connection";

import type {
  ChannelDeliveryMetrics,
  QueueTableBloat,
} from "@/routes/documentation/health-documentation";

import {
  connectionUsagePercent,
  deadTuplePercent,
} from "@/shared/health/metrics-math";
import {
  QUEUE_TABLES,
  operationalSnapshotSql,
} from "@/shared/health/metrics-queries";
import {
  legacyRunway,
  readCronJobs,
  readPartitionStates,
  readWorkerHeartbeats,
} from "@/shared/health/operational-state";
import { CronSchedulerService } from "@/shared/services/cron-scheduler-service";
import { readPrismaPool } from "@/shared/health/pool-metrics";
import { runtimeMetrics } from "@/shared/health/runtime-metrics";
import { providerMetrics } from "@/shared/health/provider-metrics";
import { readRedisMetrics } from "@/shared/health/redis-metrics";
import {
  collectDatabaseMetrics,
  withClusterSample,
} from "@/shared/health/database-metrics";
import { httpMetrics } from "@/shared/health/http-metrics";
import { shedMetrics } from "@/shared/http/load-shedding";
import { panelBudgetMetrics } from "@/shared/integration/panel-budget";
import { alertThresholdsFromEnv } from "@/shared/health/alert-rules";
import {
  readLatestTotals,
  volumeGauge,
  type VolumeTotals,
} from "@/shared/health/volume-gauge";
import { env } from "@/env";
import { processMemoryBudget } from "@/shared/lifecycle/memory-budget";
import { logger } from "@/shared/logging/logger";
import { SnapshotCache } from "@/shared/cache/snapshot-cache";
import { realtimeMetrics } from "@/websocket";
import { gateStats } from "@/shared/security/bcrypt-gate";
import { legacyContractUsage } from "@/shared/http/legacy-contract-usage";
import { deviceAgreementTotals } from "@/shared/ai-precheck/device-agreement-metrics";
import { dashboardRollupMetrics } from "@/shared/rollup/dashboard-rollup-metrics";
// Side effect: registers "ProofSigningService" (@registry).
import "@/shared/services/proof-signing/proof-signing-service";
import type { ProofSigningService } from "@/shared/services/proof-signing/proof-signing-service";

/**
 * What GET /health/metrics answers (see the route for what each number is
 * for), read in four statements instead of twenty-two, and served from a
 * ten-second snapshot.
 *
 * Measured on the perf stack (local Postgres, 40 tenants): 22 statements one
 * after the other, p50 46–54 ms per read, and each read a fresh trip through
 * the replica's 10-connection pool. Now the queue numbers are ONE statement
 * (operationalSnapshotSql: every former statement is a subquery of it, with
 * its own plan), the cron state one more, the workers and the partitions one
 * each — still one after the other, so the endpoint never takes more than one
 * slot of the pool it reports on, the property it was built around. The
 * database's own numbers (F1-06, database-metrics.ts) come after them, up to
 * three more statements in the same order, and the ramp's gauge last (F1-22:
 * one read of the newest quarter-hour cluster row, over 20 minutes of the
 * ts index). Redis is read alongside them: it is not the pool.
 *
 * The snapshot is per replica, like the runtime numbers in it, and lives ten
 * seconds: the Sistema screen, a second tab and an alert monitor polling it
 * are one read per interval, and concurrent readers share the one in flight.
 * A failed read is not cached — the next one tries again.
 */

const log = logger.child({ component: "operational-metrics" });

/**
 * The ramp's newest sums, fail-open: a refused read leaves the gauge
 * unknown (and a warning), never the whole endpoint failing during the
 * incident it is opened for.
 */
async function readVolumeTotals(): Promise<VolumeTotals | null> {
  try {
    return await readLatestTotals(new Date());
  } catch (error) {
    log.warn({ err: error }, "volume gauge read failed");

    return null;
  }
}

/** Window the per-channel notification counters cover. */
const NOTIFICATION_METRICS_WINDOW_HOURS = 24;

/** How long one read of the metrics is served before the next is made. */
const OPERATIONAL_METRICS_TTL_MS = 10 * 1000;

interface ChannelStatusCountRow {
  channel: string;
  status: string;
  n: number;
}

interface DeliveryBacklogRow {
  channel: string;
  pending_total: number;
  processing_total: number;
  processing_lease_expired: number;
  oldest_pending_seconds: number | null;
  oldest_eligible_seconds: number | null;
}

interface QueueTableStatsRow {
  table_name: string;
  partitions?: number;
  n_live_tup: number | string;
  n_dead_tup: number | string;
  last_autovacuum: string | null;
}

interface OperationalSnapshotRow {
  active_connections: number;
  max_connections: string;
  outbox_pending: number;
  outbox_eligible_seconds: number | null;
  outbox_any_seconds: number | null;
  outbox_failed: number;
  ai_pending: number;
  ai_running: number;
  ai_failed_24h: number;
  webhooks_failed_24h: number;
  whatsapp_failed_24h: number;
  whatsapp_multi_send_24h: number;
  webhook_pending_due: number;
  webhook_held: number;
  webhook_oldest_due_seconds: number | null;
  webhook_disabled_endpoints: number;
  window_rows: ChannelStatusCountRow[];
  failed_rows: Array<{ channel: string; n: number }>;
  backlog_rows: DeliveryBacklogRow[];
  queue_table_rows: QueueTableStatsRow[];
}

async function collectOperationalMetrics() {
  const notificationsSince = new Date(
    Date.now() - NOTIFICATION_METRICS_WINDOW_HOURS * 60 * 60 * 1000,
  );

  // Redis is not the pool: its ping and INFO run beside the statements.
  const redis = readRedisMetrics(() =>
    RedisConnection.getInstance().getClient(),
  );

  const [snapshot] = await database.$queryRaw<OperationalSnapshotRow[]>(
    operationalSnapshotSql(notificationsSince),
  );

  // The machinery behind the queues: a worker hung on one replica, a cron
  // job that stopped succeeding, partitions running out or never dropped
  // (OBS-10, INV-07, F2-09). Each is one statement on a small table or on
  // the catalog.
  const workers = await readWorkerHeartbeats();
  const cronJobs = await readCronJobs(
    CronSchedulerService.getInstance().registeredJobs(),
  );
  // Every registered partitioned table (plano-escala F2-09), in one
  // statement on the catalog.
  const partitions = await readPartitionStates();

  // The database's own numbers (plano-escala F1-06): one more statement,
  // pg_wal when this user may list it, and the sizes from a five-minute
  // copy. After the others, one at a time; it never throws, a part that
  // fails is a collection error.
  // After the cut of the database roles this login may not read the other
  // sessions nor pg_wal: those parts come from the cron's newest cluster
  // sample (F3-18), one more statement only then.
  const databaseMetrics = await withClusterSample(
    await collectDatabaseMetrics(),
  );

  // The limits the ops heartbeat judges with, as this environment set them
  // (ops-heartbeat-job.ts reads the same function).
  const thresholds = alertThresholdsFromEnv(env);

  // The ramp against the approved gate, the alert's own numbers (U-12).
  const volume = volumeGauge(await readVolumeTotals(), thresholds);

  const windowCounts = new Map<string, number>();
  for (const row of snapshot.window_rows) {
    windowCounts.set(`${row.channel}:${row.status}`, row.n);
  }

  const failedTotals = new Map<string, number>();
  for (const row of snapshot.failed_rows) {
    failedTotals.set(row.channel, row.n);
  }

  const backlog = new Map(
    snapshot.backlog_rows.map((row) => [row.channel, row]),
  );

  // Built from the Prisma enum so a new channel shows up here the day it is
  // added; every channel is emitted even at zero, so a dashboard never has
  // to deal with a missing key.
  const channels: ChannelDeliveryMetrics[] = Object.values(
    NotificationChannel,
  ).map((channel) => ({
    channel,
    pending: windowCounts.get(`${channel}:PENDING`) ?? 0,
    processing: windowCounts.get(`${channel}:PROCESSING`) ?? 0,
    delivered: windowCounts.get(`${channel}:DELIVERED`) ?? 0,
    failed: windowCounts.get(`${channel}:FAILED`) ?? 0,
    failed_total: failedTotals.get(channel) ?? 0,
    pending_total: backlog.get(channel)?.pending_total ?? 0,
    processing_lease_expired:
      backlog.get(channel)?.processing_lease_expired ?? 0,
    oldest_pending_seconds:
      backlog.get(channel)?.oldest_pending_seconds ?? null,
    oldest_eligible_seconds:
      backlog.get(channel)?.oldest_eligible_seconds ?? null,
  }));

  const queueTables: QueueTableBloat[] = QUEUE_TABLES.map((table) => {
    const row = snapshot.queue_table_rows.find(
      (stat) => stat.table_name === table,
    );

    const live = Number(row?.n_live_tup ?? 0);
    const dead = Number(row?.n_dead_tup ?? 0);

    return {
      table,
      partitions: row?.partitions ?? 0,
      n_live_tup: live,
      n_dead_tup: dead,
      dead_tuple_percent: deadTuplePercent(live, dead),
      last_autovacuum: row?.last_autovacuum
        ? new Date(row.last_autovacuum).toISOString()
        : null,
    };
  });

  // This replica's own saturation (GAP3-10, OBS-11): the pool is what fills
  // first under load, and pg_stat_activity cannot see it.
  const runtime = {
    ...runtimeMetrics.snapshot(),
    prisma_pool: await readPrismaPool(databasePool, process.env.DATABASE_URL),
    bcrypt: gateStats(),
  };

  const activeConnections = Number(snapshot.active_connections ?? 0);
  const maxConnections = Number(snapshot.max_connections ?? 0);

  return {
    timestamp: new Date().toISOString(),
    database: {
      active_connections: activeConnections,
      max_connections: maxConnections,
      connection_usage_percent: connectionUsagePercent(
        activeConnections,
        maxConnections,
      ),
      ...databaseMetrics,
      // The database alerts' own limits (F1-11), for the web's Sistema tab:
      // two are tuned by env, and a hardcoded copy there kept a card green
      // while the heartbeat paged (a 90 s write with the limit at 60).
      alert_limits: {
        xid_age: thresholds.xidAge,
        archive_lag_seconds: thresholds.archiveLagSec,
        long_write_xact_seconds: thresholds.longWriteXactSec,
        pg_wal_bytes: thresholds.pgWalBytes,
        pitr_expected: env.PITR_EXPECTED,
      },
    },
    outbox: {
      pending: snapshot.outbox_pending,
      failed: snapshot.outbox_failed,
      oldest_pending_seconds: snapshot.outbox_eligible_seconds ?? null,
      oldest_pending_any_seconds: snapshot.outbox_any_seconds ?? null,
    },
    ai_pipeline: {
      pending: snapshot.ai_pending,
      running: snapshot.ai_running,
      failed_24h: snapshot.ai_failed_24h ?? 0,
    },
    notifications: {
      window_hours: NOTIFICATION_METRICS_WINDOW_HOURS,
      failed_total: channels.reduce(
        (total, metrics) => total + metrics.failed_total,
        0,
      ),
      channels,
      whatsapp_failed_24h: snapshot.whatsapp_failed_24h ?? 0,
      whatsapp_multi_send_24h: snapshot.whatsapp_multi_send_24h ?? 0,
    },
    queue_tables: queueTables,
    // Switched-off endpoints and held events were invisible to operators.
    webhooks: {
      pending_due: snapshot.webhook_pending_due ?? 0,
      held: snapshot.webhook_held ?? 0,
      oldest_due_seconds: snapshot.webhook_oldest_due_seconds ?? null,
      disabled_endpoints: snapshot.webhook_disabled_endpoints ?? 0,
      failed_24h: snapshot.webhooks_failed_24h ?? 0,
    },
    workers,
    cron_jobs: cronJobs,
    partitions,
    // The shape before the registry, for one release: the web's Sistema
    // screen reads it.
    driver_position: legacyRunway(partitions.driver_position),
    runtime,
    // Per replica, since it started (decisions 14.2–14.4, 14.8).
    legacy_contracts: legacyContractUsage(),
    ai_device_agreement_total: deviceAgreementTotals(),
    // The shadow of the dashboard's closed days (plano-escala F4-22): per
    // replica, since it started; the log keeps every divergence.
    dashboard_rollup: {
      mode: env.DASHBOARD_ROLLUP_MODE,
      ...dashboardRollupMetrics(),
    },
    proof_signing: container
      .resolve<ProofSigningService>("ProofSigningService")
      .health(),
    // Contract §32: provider latency and error rate per channel, the
    // replica's sockets and Redis — per replica, like `runtime`.
    providers: providerMetrics.snapshot(),
    realtime: realtimeMetrics(),
    redis: await redis,
    // This replica's HTTP counters, histogram per route group and the
    // positions' contracts (plano-escala F1-09) — per replica, like
    // `runtime`; the ops_sample rows carry every replica's.
    http: httpMetrics.snapshot(),
    // What load shedding refused, or would have refused in observe, since
    // the ops_sample row of the last minute (plano-escala F2-24): per
    // replica, like `http`.
    shedding: shedMetrics.snapshot(),
    // The companies' panel budgets on this replica since the last minute's
    // ops_sample row (plano-escala F2-28): charged, refused, would refuse.
    panel_budget: panelBudgetMetrics.snapshot(),
    // The newest quarter-hour sums of the cluster rows against the approved
    // gate (plano-escala F1-22): what the volume-near-gate alert judges.
    volume,
    // This replica's memory budget as the boot checked it (plano-escala
    // U-15): per replica, like `runtime`.
    ...memoryBudgetMetrics(),
  };
}

function memoryBudgetMetrics() {
  const budget = processMemoryBudget(env);

  return {
    memory_budget_ok: budget.ok,
    memory_budget: {
      mode: budget.mode,
      checked: budget.checked,
      limit_mb: budget.limitMb,
      total_mb: budget.totalMb,
      heap_mb: budget.parts.heapMb,
      spreadsheet_reads: budget.parts.spreadsheetReads,
      spreadsheet_max_old_mb: budget.parts.spreadsheetMaxOldMb,
      cpu_pool_threads: budget.parts.cpuPoolThreads,
      cpu_pool_thread_max_old_mb: budget.parts.cpuPoolThreadMaxOldMb,
      native_mb: budget.parts.nativeMb,
      reason: budget.reason,
    },
  };
}

type OperationalMetrics = Awaited<ReturnType<typeof collectOperationalMetrics>>;

// Per replica (store: null): the runtime, pool, socket and provider numbers
// in it are this replica's, and a copy from another would mislabel them.
const cache = new SnapshotCache<OperationalMetrics>({
  name: "operational-metrics",
  ttlMs: OPERATIONAL_METRICS_TTL_MS,
  compute: collectOperationalMetrics,
  store: null,
});

async function readOperationalMetrics(): Promise<OperationalMetrics> {
  return (await cache.read()).value;
}

/** For tests: the next read goes to the database again. */
function resetOperationalMetricsCache(): void {
  cache.reset();
}

export {
  NOTIFICATION_METRICS_WINDOW_HOURS,
  OPERATIONAL_METRICS_TTL_MS,
  collectOperationalMetrics,
  readOperationalMetrics,
  resetOperationalMetricsCache,
  type OperationalMetrics,
};
