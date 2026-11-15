import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";

import type { CronJobDefinition } from "@/shared/services/cron-scheduler-service";
import type { OperationalSnapshot } from "@/shared/health/alert-rules";
import type { RedisMetrics } from "@/shared/health/redis-metrics";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The cluster's row of the per-minute series (plano-escala F1-10), against
 * Postgres and Redis.
 *
 * Every replica's node-cron fires the ops heartbeat each minute; the unique
 * (jobName, scheduledFor) insert elects one, and that one writes the
 * `role = 'cluster'` row after its ping, stamped with the elected minute.
 * Two replicas firing the same minute must leave ONE row: two would double
 * every cluster number a reader sums, and none would be a hole in the PITR
 * drill's marker.
 *
 * Two scheduler instances stand in for two replicas, as in
 * cron-scheduler-lock.test.ts: the election lives in the database.
 */
const prisma = createPrismaClient();

type Scheduler = {
  runExclusively(definition: CronJobDefinition, slot?: Date): Promise<void>;
};

let replicaA: Scheduler;
let replicaB: Scheduler;
let heartbeat: CronJobDefinition;

beforeAll(async () => {
  const { CronSchedulerService } =
    await import("@/shared/services/cron-scheduler-service");
  ({ opsHeartbeatJob: heartbeat } =
    await import("@/jobs/cron/ops-heartbeat-job"));

  // The constructor is private (one per process in production).
  const Constructor = CronSchedulerService as unknown as new () => Scheduler;

  replicaA = new Constructor();
  replicaB = new Constructor();
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
});

/** A minute of its own, far from now, at `minute` past some hour (UTC). */
function slotAt(minute: number): Date {
  const hours = 1_000 + Math.floor(Math.random() * 100_000);

  return new Date(Date.UTC(2026, 0, 1) + hours * 3_600_000 + minute * 60_000);
}

async function clusterRows(ts: Date) {
  return prisma.$queryRaw<
    Array<{ role: string; replica: string; metrics: Record<string, unknown> }>
  >`SELECT role, replica, metrics FROM ops_sample WHERE role = 'cluster' AND ts = ${ts}`;
}

describe("the cluster row of the ops heartbeat", () => {
  it("is written once a minute however many replicas fire", async () => {
    const slot = slotAt(7);

    await Promise.all([
      replicaA.runExclusively(heartbeat, slot),
      replicaB.runExclusively(heartbeat, slot),
    ]);

    const rows = await clusterRows(slot);

    expect(rows).toHaveLength(1);
    expect(rows[0].metrics).toMatchObject({
      v: 1,
      queues: expect.any(Object),
      database: {
        connection_usage_percent: expect.any(Number),
        xid_age: expect.any(Number),
        archive_mode: "off",
        pg_wal: { readable: true },
        pg_stat_statements: "ready",
        collection_errors: [],
      },
      redis: { status: "up" },
    });

    // The per-minute row stays small: the sizes ride on quarter-hours.
    expect(rows[0].metrics.database).not.toHaveProperty("sizes");

    const [{ runs }] = await prisma.$queryRaw<Array<{ runs: number }>>`
      SELECT count(*)::int AS runs FROM scheduled_job_execution
      WHERE "jobName" = 'ops-heartbeat' AND "scheduledFor" = ${slot}
        AND status = 'SUCCEEDED'
    `;

    expect(runs).toBe(1);
  });

  it("carries the sizes and the hot tables on a quarter-hour", async () => {
    const slot = slotAt(45);

    await replicaA.runExclusively(heartbeat, slot);

    const [row] = await clusterRows(slot);
    const database = row.metrics.database as Record<string, unknown>;

    expect(database.sizes).toMatchObject({
      database_bytes: expect.any(Number),
    });
    expect(database.hot_tables).toContainEqual(
      expect.objectContaining({ table: "driver_position" }),
    );
  });
});

/**
 * The scale plan's database and Redis alerts (plano-escala F1-11), on the
 * real views and the real series.
 *
 * Redis' evicted_keys is a counter since it started, so the alert reads
 * the keys evicted since the cluster row of about 15 minutes ago: the
 * newest 'cluster' row between 15 and 20 minutes before the slot, never a
 * process row of the same minute, never a newer one. A wrong pick is an
 * alert that compares the wrong numbers.
 */
describe("the alerts on the cluster readings", () => {
  const SNAPSHOT: OperationalSnapshot = {
    now: new Date(),
    outboxEligibleLagSec: null,
    deliveryEligibleLagSec: { internal: null, external: null },
    webhookDueLagSec: null,
    aiEligibleLagSec: null,
    deliveryFailures: [],
    aiCredentialFailures: 0,
    cronJobs: [],
    partitionRunwayOk: true,
    partitionRunwayDays: 7,
    stuckWorkers: [],
    connectionUsagePercent: 10,
    redisOk: true,
    collectionErrors: [],
  };

  async function liveRedis(): Promise<RedisMetrics> {
    const { readRedisMetrics } = await import("@/shared/health/redis-metrics");
    const { RedisConnection } =
      await import("@/../infra/cache/redis-connection");

    return readRedisMetrics(() => RedisConnection.getInstance().getClient());
  }

  /** The live Redis, with a ceiling and counters this test chooses. */
  function redisWith(evicted: number, uptime: number) {
    return async (): Promise<RedisMetrics> => ({
      ...(await liveRedis()),
      maxmemory_mb: 256,
      maxmemory_policy: "allkeys-lru",
      evicted_keys: evicted,
      uptime_seconds: uptime,
    });
  }

  async function seedRow(
    ts: Date,
    role: string,
    redis: Record<string, number>,
  ): Promise<void> {
    await prisma.opsSample.create({
      data: { ts, role, replica: "seed", metrics: { v: 1, redis } },
    });
  }

  it("compare Redis' evictions with the cluster row of 15 minutes ago", async () => {
    const slot = slotAt(30);
    const before = (minutes: number) =>
      new Date(slot.getTime() - minutes * 60_000);

    // The baseline, a newer cluster row, one out of reach, and a process
    // row of the baseline's minute.
    await seedRow(before(15), "cluster", {
      evicted_keys: 10,
      uptime_seconds: 100_000,
    });
    await seedRow(before(14), "cluster", {
      evicted_keys: 12,
      uptime_seconds: 100_060,
    });
    await seedRow(before(21), "cluster", {
      evicted_keys: 0,
      uptime_seconds: 99_640,
    });
    await seedRow(before(15), "all", { evicted_keys: 0 });

    const { readClusterReadings } =
      await import("@/shared/health/cluster-sample");
    const { heartbeatReasons } = await import("@/jobs/cron/ops-heartbeat-job");

    const readings = await readClusterReadings(slot, {
      readRedis: redisWith(13, 100_900),
    });

    expect(readings.redisEvictions).toEqual({ delta: 3, windowSec: 900 });

    const reasons = heartbeatReasons(SNAPSHOT, readings);

    expect(reasons.filter((reason) => reason.startsWith("Redis"))).toEqual([
      expect.stringMatching(/^Redis despejou 3 chave\(s\) em 15 min/),
    ]);
  });

  it("compare nothing when no cluster row is 15 to 20 minutes old", async () => {
    const slot = slotAt(40);

    await seedRow(new Date(slot.getTime() - 25 * 60_000), "cluster", {
      evicted_keys: 0,
      uptime_seconds: 100_000,
    });

    const { readClusterReadings } =
      await import("@/shared/health/cluster-sample");

    const readings = await readClusterReadings(slot, {
      readRedis: redisWith(500, 101_500),
    });

    expect(readings.redisEvictions).toBeNull();
  });

  it("raise no database reason on a healthy server, and the long write past its limit", async () => {
    const { readClusterReadings, withClusterReadings } =
      await import("@/shared/health/cluster-sample");
    const { heartbeatReasons } = await import("@/jobs/cron/ops-heartbeat-job");
    const { DEFAULT_ALERT_THRESHOLDS, evaluateAlerts } =
      await import("@/shared/health/alert-rules");

    const readings = await readClusterReadings(slotAt(1));

    // archive_mode off and PITR_EXPECTED unset: nothing about archiving.
    expect(readings.database.parameters?.archive_mode).toBe("off");
    expect(readings.database.collection_errors).toEqual([]);

    const reasons = heartbeatReasons(SNAPSHOT, readings);
    const redisMemoryReason =
      readings.redis.maxmemory_mb === null ||
      readings.redis.maxmemory_policy === "noeviction";

    // The CI's Redis service runs without a ceiling: the memory rule says
    // so, and nothing else does.
    expect(reasons).toEqual(
      redisMemoryReason
        ? [expect.stringMatching(/^Redis (sem teto|com maxmemory-policy)/)]
        : [],
    );

    const writer = await secondConnection();

    try {
      await writer.query("BEGIN");
      await writer.query("SELECT pg_current_xact_id()");

      await vi.waitFor(
        async () => {
          const held = await readClusterReadings(slotAt(2));
          const judged = evaluateAlerts(withClusterReadings(SNAPSHOT, held), {
            ...DEFAULT_ALERT_THRESHOLDS,
            longWriteXactSec: 2,
          });

          expect(judged).toContainEqual(
            expect.stringMatching(/^Postgres: transação de escrita aberta há/),
          );
        },
        { timeout: 30_000, interval: 500 },
      );
    } finally {
      await writer.query("ROLLBACK").catch(() => undefined);
      await writer.end();
    }
  }, 60_000);
});

/** A plain session on this file's database, apart from the API's pool. */
async function secondConnection(): Promise<pg.Client> {
  const url = new URL(process.env.DATABASE_URL as string);

  url.searchParams.delete("schema");

  const client = new pg.Client({
    connectionString: url.toString(),
    connectionTimeoutMillis: 10_000,
  });

  await client.connect();

  return client;
}
