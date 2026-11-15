import { describe, expect, it, vi } from "vitest";

import type { OperationalSnapshot } from "@/shared/health/alert-rules";
import type { DatabaseMetrics } from "@/shared/health/database-metrics";
import type { RedisMetrics } from "@/shared/health/redis-metrics";
import {
  buildClusterSampleRow,
  carriesSizes,
  recordClusterSample,
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
 *    OPS_SAMPLE_ENABLED=false writes nothing and reads nothing.
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

describe("recording the cluster row", () => {
  const SLOT = new Date("2026-11-15T12:15:00.000Z");

  it("reads the database with the sizes on a quarter-hour and writes once", async () => {
    const readDatabase = vi.fn(async () => database());
    const write = vi.fn(async () => undefined);

    await recordClusterSample(SLOT, snapshot(), {
      enabled: true,
      identity: IDENTITY,
      readDatabase,
      readRedis: async () => REDIS,
      write,
    });

    expect(readDatabase).toHaveBeenCalledWith(true);
    expect(write).toHaveBeenCalledTimes(1);
    expect((write.mock.calls[0] as unknown[])[0]).toMatchObject({
      ts: SLOT,
      role: "cluster",
    });
  });

  it("never throws when a read or the write fails", async () => {
    await expect(
      recordClusterSample(SLOT, snapshot(), {
        enabled: true,
        identity: IDENTITY,
        readDatabase: async () => {
          throw new Error("ECONNREFUSED");
        },
        readRedis: async () => REDIS,
        write: async () => undefined,
      }),
    ).resolves.toBeUndefined();

    await expect(
      recordClusterSample(SLOT, snapshot(), {
        enabled: true,
        identity: IDENTITY,
        readDatabase: async () => database(),
        readRedis: async () => REDIS,
        write: async () => {
          throw new Error("ECONNREFUSED");
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("reads and writes nothing when the series is switched off", async () => {
    const readDatabase = vi.fn(async () => database());
    const readRedis = vi.fn(async () => REDIS);
    const write = vi.fn(async () => undefined);

    await recordClusterSample(SLOT, snapshot(), {
      enabled: false,
      identity: IDENTITY,
      readDatabase,
      readRedis,
      write,
    });

    expect(readDatabase).not.toHaveBeenCalled();
    expect(readRedis).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
});
