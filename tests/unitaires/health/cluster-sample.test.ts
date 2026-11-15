import { describe, expect, it, vi } from "vitest";

import type { OperationalSnapshot } from "@/shared/health/alert-rules";
import type { DatabaseMetrics } from "@/shared/health/database-metrics";
import type { RedisMetrics } from "@/shared/health/redis-metrics";
import {
  buildClusterSampleRow,
  carriesSizes,
  evictionsSince,
  readClusterReadings,
  recordClusterSample,
  withClusterReadings,
} from "@/shared/health/cluster-sample";
import type { OpsSampleRow } from "@/shared/health/ops-sample";

/**
 * The cluster's row of the per-minute series (plano-escala F1-10).
 *
 * The process rows say what each process saw; the queues, the archiver,
 * the xid, the oldest write, pg_wal and Redis are one reading for the whole
 * cluster, written once a minute by the ops heartbeat's elected replica,
 * after its ping. What this pins:
 *
 *  - the row is the elected minute's, `role = 'cluster'`, a v=1 document
 *    of infra numbers with no key that could carry a person or a tenant;
 *  - the sizes and the hot tables ride only on quarter-hour rows;
 *  - a collection error keeps its part name, never the message;
 *  - a failed read or write never throws (the ping already went), and
 *    OPS_SAMPLE_ENABLED=false writes nothing;
 *  - the readings are taken before the ping, once, because the alerts
 *    judge them too (F1-11): the database's numbers, Redis, and the keys
 *    Redis evicted since the cluster row of ~15 minutes ago.
 *
 * One row a minute with two replicas is tests/E2E/ops-heartbeat.test.ts.
 */

const IDENTITY = { role: "all" as const, replica: "api-1", commit: "abc1234" };

function snapshot(): OperationalSnapshot {
  return {
    now: new Date("2026-11-15T12:01:03.000Z"),
    outboxEligibleLagSec: 4,
    deliveryEligibleLagSec: { internal: 1, external: null },
    webhookDueLagSec: null,
    aiEligibleLagSec: 2,
    deliveryFailures: [{ channel: "EMAIL", lastError: "550 mailbox gone" }],
    aiCredentialFailures: 0,
    aiProviderPausedRequests: 0,
    cronJobs: [],
    partitionRunwayOk: true,
    partitionRunwayDays: 6,
    stuckWorkers: [{ replica: "api-2", worker: "ai-analysis" }],
    connectionUsagePercent: 12,
    redisOk: true,
    collectionErrors: ["webhook_delivery: relation does not exist"],
  };
}

function database(): DatabaseMetrics {
  return {
    xid_age: 1_000,
    xid_age_database: 900,
    mxid_age: 1,
    cache_hit_ratio: 0.99,
    blocks_hit: 99,
    blocks_read: 1,
    oldest_write_xact_seconds: 3.2,
    oldest_snapshot_seconds: 3.4,
    oldest_snapshot_xmin_age: 2,
    stats_cluster_wide: true,
    archiver: {
      archived_count: 0,
      failed_count: 0,
      last_archived_at: null,
      last_archived_age_seconds: null,
      last_failed_at: null,
    },
    hot_tables: [
      {
        table: "driver_position",
        partitions: 9,
        n_live_tup: 10,
        n_dead_tup: 0,
        dead_tuple_percent: 0,
        last_autovacuum: null,
      },
    ],
    parameters: { archive_mode: "off" } as DatabaseMetrics["parameters"],
    pg_stat_statements: "not_loaded",
    pg_wal: { readable: true, files: 3, bytes: 50_331_648 },
    sizes: {
      database_bytes: 1_000,
      tables: [{ table: "driver_position", total_bytes: 100 }],
      measured_at: "2026-11-15T12:15:01.000Z",
    },
    collection_errors: [],
  };
}

const REDIS = { status: "up", evicted_keys: 0 } as RedisMetrics;

/** Every key of a document, at every depth. */
function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (value === null || typeof value !== "object") return [];

  return Object.entries(value).flatMap(([key, inner]) => [
    key,
    ...keysOf(inner),
  ]);
}

const PERSON_OR_TENANT =
  /business|tenant|\busers?\b|user_?id|driver|customer|person|email|phone|cpf|cnpj|\bip\b|address|token|session/i;

function row(slot: Date): OpsSampleRow {
  return buildClusterSampleRow({
    slot,
    identity: IDENTITY,
    snapshot: snapshot(),
    database: database(),
    redis: REDIS,
  });
}

describe("the cluster row", () => {
  it("is the elected minute's, role cluster, a v=1 document", () => {
    const minute = new Date("2026-11-15T12:01:00.000Z");
    const built = row(minute);

    expect(built).toMatchObject({
      ts: minute,
      role: "cluster",
      replica: "api-1",
      commit: "abc1234",
    });
    expect(built.metrics).toMatchObject({
      v: 1,
      queues: {
        outbox_eligible_lag_seconds: 4,
        delivery_internal_lag_seconds: 1,
        delivery_external_lag_seconds: null,
        webhook_due_lag_seconds: null,
        ai_eligible_lag_seconds: 2,
        stuck_workers: 1,
        partition_runway_days: 6,
      },
      database: {
        connection_usage_percent: 12,
        xid_age: 1_000,
        oldest_write_xact_seconds: 3.2,
        archive_mode: "off",
        pg_wal: { readable: true, files: 3, bytes: 50_331_648 },
        pg_stat_statements: "not_loaded",
      },
      redis: { status: "up", evicted_keys: 0 },
    });
  });

  it("carries the sizes and the hot tables only on quarter-hour rows", () => {
    const minute = row(new Date("2026-11-15T12:01:00.000Z"));
    const quarter = row(new Date("2026-11-15T12:15:00.000Z"));
    const minuteDatabase = minute.metrics.database as Record<string, unknown>;
    const quarterDatabase = quarter.metrics.database as Record<string, unknown>;

    expect(minuteDatabase).not.toHaveProperty("sizes");
    expect(minuteDatabase).not.toHaveProperty("hot_tables");
    expect(quarterDatabase.sizes).toEqual(database().sizes);
    expect(quarterDatabase.hot_tables).toEqual(database().hot_tables);

    const at = (minute: number) => new Date(Date.UTC(2026, 10, 15, 3, minute));

    for (const minute of [0, 15, 30, 45]) {
      expect(carriesSizes(at(minute))).toBe(true);
    }
    expect(carriesSizes(at(14))).toBe(false);
  });

  it("carries the deliveries the process rows counted, when read", () => {
    const slot = new Date("2026-11-15T12:15:00.000Z");
    const totals = { last24h: 30, last7d: 90, since: null, at: slot };

    const built = buildClusterSampleRow({
      slot,
      identity: IDENTITY,
      snapshot: snapshot(),
      database: database(),
      redis: REDIS,
      volume: { created: 2, totals },
    });

    expect(built.metrics.deliveries).toEqual({
      created: 2,
      last_24h: 30,
      last_7d: 90,
      since: null,
    });

    // Unread is absent, never a zero a reader would sum.
    expect(row(slot).metrics).not.toHaveProperty("deliveries");

    const judged = withClusterReadings(snapshot(), {
      database: database(),
      redis: REDIS,
      redisEvictions: null,
      volume: { created: 2, totals },
    });

    expect(judged.volume).toEqual({ last24h: 30, last7d: 90 });
  });

  it("names a collection error by its part, never by its message", () => {
    expect(row(new Date()).metrics.collection_errors).toEqual([
      "webhook_delivery",
    ]);
  });

  it("carries no key that could name a person or a tenant", () => {
    const built = row(new Date("2026-11-15T12:15:00.000Z"));

    // "driver_position" is a table name, a value, never a key.
    expect(
      keysOf(built.metrics).filter((key) => PERSON_OR_TENANT.test(key)),
    ).toEqual([]);
    // The failures' texts are the snapshot's, never the row's.
    expect(JSON.stringify(built.metrics)).not.toContain("mailbox");
  });
});

describe("reading the cluster", () => {
  const SLOT = new Date("2026-11-15T12:15:00.000Z");

  it("reads the database with the sizes on a quarter-hour, then Redis and the baseline", async () => {
    const order: string[] = [];
    const readDatabase = vi.fn(async (_withSizes: boolean) => {
      order.push("database");
      return database();
    });

    const readings = await readClusterReadings(SLOT, {
      readDatabase,
      readRedis: async () => {
        order.push("redis");
        return { ...REDIS, evicted_keys: 7, uptime_seconds: 86_400 };
      },
      readBaseline: async (slot) => {
        order.push("baseline");
        expect(slot).toBe(SLOT);
        return {
          ts: new Date(SLOT.getTime() - 15 * 60_000),
          evicted_keys: 5,
          uptime_seconds: 85_500,
        };
      },
      readVolume: async (slot) => {
        order.push("volume");
        expect(slot).toBe(SLOT);
        return { created: 4, totals: null };
      },
    });

    expect(readDatabase).toHaveBeenCalledWith(true);
    // One after the other: the heartbeat never takes two slots of the pool.
    expect(order).toEqual(["database", "redis", "baseline", "volume"]);
    expect(readings.redisEvictions).toEqual({ delta: 2, windowSec: 900 });
    expect(readings.volume).toEqual({ created: 4, totals: null });
  });

  it("skips the sizes off the quarter-hour", async () => {
    const readDatabase = vi.fn(async (_withSizes: boolean) => database());

    await readClusterReadings(new Date("2026-11-15T12:16:00.000Z"), {
      readDatabase,
      readRedis: async () => REDIS,
      readBaseline: async () => null,
      readVolume: async () => null,
    });

    expect(readDatabase).toHaveBeenCalledWith(false);
  });

  it("never throws: a baseline that cannot be read compares nothing", async () => {
    const readings = await readClusterReadings(SLOT, {
      readDatabase: async () => database(),
      readRedis: async () => REDIS,
      readBaseline: async () => {
        throw new Error("ECONNREFUSED");
      },
      readVolume: async () => null,
    });

    expect(readings.redisEvictions).toBeNull();
    expect(readings.redis).toBe(REDIS);
  });

  it("never throws: a volume that cannot be read judges nothing", async () => {
    // A planning gauge (U-12), never a reason to page.
    const readings = await readClusterReadings(SLOT, {
      readDatabase: async () => database(),
      readRedis: async () => REDIS,
      readBaseline: async () => null,
      readVolume: async () => {
        throw new Error("ECONNREFUSED");
      },
    });

    expect(readings.volume).toBeNull();

    const judged = withClusterReadings(snapshot(), readings);

    expect(judged).not.toHaveProperty("volume");
    expect(judged.collectionErrors).toEqual(snapshot().collectionErrors);
  });
});

/**
 * Redis' evicted_keys is a counter since the server started: the alert
 * reads the keys evicted since the 'cluster' row of about 15 minutes ago.
 * A Redis that restarted in between counts from zero again, so everything
 * it holds happened inside the window.
 */
describe("the evictions since the baseline row", () => {
  const SLOT = new Date("2026-11-15T12:15:00.000Z");
  const baseline = (
    evicted: number | null,
    uptime: number | null = 90_000,
  ) => ({
    ts: new Date(SLOT.getTime() - 15 * 60_000),
    evicted_keys: evicted,
    uptime_seconds: uptime,
  });
  const redis = (evicted: number | null, uptime: number | null = 90_900) =>
    ({
      ...REDIS,
      status: "up",
      evicted_keys: evicted,
      uptime_seconds: uptime,
    }) as RedisMetrics;

  it.each([
    { now: 12, before: 10, delta: 2 },
    { now: 10, before: 10, delta: 0 },
    { now: 0, before: 0, delta: 0 },
  ])(
    "is the counter's growth: $before then $now is $delta",
    ({ now, before, delta }) => {
      expect(evictionsSince(redis(now), baseline(before), SLOT)).toEqual({
        delta,
        windowSec: 900,
      });
    },
  );

  it("counts everything since a restart inside the window", () => {
    // Up for 5 minutes: the counter of the old server is gone.
    expect(evictionsSince(redis(3, 300), baseline(40), SLOT)).toEqual({
      delta: 3,
      windowSec: 900,
    });
    // Uptime unread, but the counter went backwards: a restart too.
    expect(evictionsSince(redis(3, null), baseline(40), SLOT)).toEqual({
      delta: 3,
      windowSec: 900,
    });
  });

  it("compares nothing without a row, a number, or Redis", () => {
    expect(evictionsSince(redis(5), null, SLOT)).toBeNull();
    expect(evictionsSince(redis(5), baseline(null), SLOT)).toBeNull();
    expect(evictionsSince(redis(null), baseline(5), SLOT)).toBeNull();
    expect(
      evictionsSince({ ...redis(5), status: "down" }, baseline(1), SLOT),
    ).toBeNull();
  });
});

describe("the snapshot the alerts judge", () => {
  it("carries the database and Redis numbers the rules read", () => {
    const judged = withClusterReadings(snapshot(), {
      database: {
        ...database(),
        archiver: {
          archived_count: 10,
          failed_count: 2,
          last_archived_at: "2026-11-15T12:00:30.000Z",
          last_archived_age_seconds: 33,
          last_failed_at: "2026-11-15T11:00:00.000Z",
        },
      },
      redis: {
        ...REDIS,
        maxmemory_mb: 256,
        maxmemory_policy: "allkeys-lru",
      },
      redisEvictions: { delta: 0, windowSec: 900 },
    });

    expect(judged.database).toEqual({
      archiveMode: "off",
      lastArchivedAgeSec: 33,
      lastArchivedAt: new Date("2026-11-15T12:00:30.000Z"),
      lastArchiveFailedAt: new Date("2026-11-15T11:00:00.000Z"),
      archiveFailedCount: 2,
      xidAge: 1_000,
      oldestWriteXactSec: 3.2,
      pgWalBytes: 50_331_648,
    });
    expect(judged.redis).toEqual({
      up: true,
      maxmemoryMb: 256,
      maxmemoryPolicy: "allkeys-lru",
      evictedKeys: { delta: 0, windowSec: 900 },
    });
    // The snapshot's own parts are kept as they were.
    expect(judged.collectionErrors).toEqual(snapshot().collectionErrors);
  });

  it("turns an unread database part into a reason, never an unread size", () => {
    const judged = withClusterReadings(snapshot(), {
      database: {
        ...database(),
        collection_errors: [
          { part: "core", code: "57014" },
          { part: "pg_wal", code: null },
          { part: "sizes", code: "42501" },
        ],
      },
      redis: REDIS,
      redisEvictions: null,
    });

    expect(judged.collectionErrors).toEqual([
      ...snapshot().collectionErrors,
      "métricas do banco (core): SQLSTATE 57014",
      "métricas do banco (pg_wal): sem resposta",
    ]);
  });
});

describe("recording the cluster row", () => {
  const SLOT = new Date("2026-11-15T12:15:00.000Z");
  const READINGS = () => ({
    database: database(),
    redis: REDIS,
    redisEvictions: null,
  });

  it("writes the readings once, reading nothing again", async () => {
    const write = vi.fn(async (_row: OpsSampleRow) => undefined);

    await recordClusterSample(SLOT, snapshot(), READINGS(), {
      enabled: true,
      identity: IDENTITY,
      write,
    });

    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toMatchObject({
      ts: SLOT,
      role: "cluster",
      metrics: { database: { sizes: database().sizes } },
    });
  });

  it("never throws when the write fails", async () => {
    await expect(
      recordClusterSample(SLOT, snapshot(), READINGS(), {
        enabled: true,
        identity: IDENTITY,
        write: async () => {
          throw new Error("ECONNREFUSED");
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("writes nothing when the series is switched off", async () => {
    const write = vi.fn(async () => undefined);

    await recordClusterSample(SLOT, snapshot(), READINGS(), {
      enabled: false,
      identity: IDENTITY,
      write,
    });

    expect(write).not.toHaveBeenCalled();
  });
});
