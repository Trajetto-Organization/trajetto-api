import { describe, expect, it, vi } from "vitest";

import type { Prisma } from "@prisma/client";

import {
  CLUSTER_SAMPLE_MAX_AGE_MS,
  DATABASE_SIZES_TTL_MS,
  cacheHitRatio,
  collectDatabaseMetrics,
  createTimedMemo,
  mergeClusterSample,
  withClusterSample,
  type ClusterDatabaseSample,
  type DatabaseMetrics,
} from "@/shared/health/database-metrics";
import {
  pgStatStatementsStateFromCatalog,
  preloadsPgStatStatements,
} from "@/shared/health/pg-stat-statements-state";

/**
 * The database's own numbers on /health/metrics (plano-escala F1-06).
 *
 * The plan's alerts (archiver, xid, the oldest write, pg_wal) and its
 * capacity readings (hit ratio, hot tables, sizes, parameters) read these,
 * so a wrong number is a wrong decision, and a missing one a silent alert.
 * What this pins, without a database:
 *
 *  - three reads, one after the other: the cheap statement, pg_wal only when
 *    the first said this user may list it, and the sizes;
 *  - a part that fails is a `collection_errors` entry with its SQLSTATE, its
 *    fields null, and the other parts still answer: nothing throws;
 *  - the sizes come from a copy kept five minutes, and a failure is never
 *    kept;
 *  - ratios and ages are never NaN nor negative, and pg_stat_statements'
 *    state comes from the catalog alone.
 *
 * The real views are read by tests/E2E/health-metrics.test.ts.
 */

type Sql = Prisma.Sql;
type Client = Pick<Prisma.TransactionClient, "$queryRaw">;
type Part = "core" | "wal" | "sizes";

/** Which of the three reads a statement is. */
function partOf(sql: Sql): Part {
  if (sql.sql.includes("FROM pg_ls_waldir()")) return "wal";
  if (sql.sql.includes("pg_database_size")) return "sizes";

  return "core";
}

const CORE_ROW = {
  xid_age: 1_200_000,
  xid_age_database: 900_000,
  mxid_age: 12,
  blocks_hit: 990,
  blocks_read: 10,
  oldest_write_xact_seconds: 4.5,
  oldest_snapshot_seconds: 6,
  oldest_snapshot_xmin_age: 30,
  archived_count: 0,
  archive_failed_count: 0,
  last_archived_at: null,
  last_archived_age_seconds: null,
  last_archive_failed_at: null,
  hot_tables: [
    {
      table_name: "driver_position",
      partitions: 9,
      n_live_tup: 300,
      n_dead_tup: 100,
      last_autovacuum: "2026-11-15T03:00:00+00:00",
    },
  ],
  parameters: {
    shared_buffers: "128MB",
    archive_mode: "off",
    shared_preload_libraries: "pg_stat_statements",
  },
  pgss_installed: true,
  stats_cluster_wide: true,
  wal_readable: true,
};

/** A client that answers each of the three reads by its SQL. */
function fakeClient(answers: {
  core?: () => unknown[];
  wal?: () => unknown[];
  sizes?: () => unknown[];
}) {
  const seen: string[] = [];

  const $queryRaw = vi.fn(async (sql: Sql) => {
    const part = partOf(sql);

    seen.push(part);

    const answer = answers[part];

    if (!answer) throw new Error(`unexpected ${part} read`);

    return answer();
  });

  return {
    client: { $queryRaw } as unknown as Client,
    seen,
  };
}

/** A refusal shaped like the adapter's, with its SQLSTATE. */
function refusal(code: string) {
  return Object.assign(new Error("refused"), {
    code: "P2010",
    meta: { code },
  });
}

const SIZES_ROW = {
  database_bytes: 52_428_800,
  tables: [{ table_name: "driver_position", total_bytes: 1_048_576 }],
};

describe("the database metrics", () => {
  it("read the three parts in order and shape them", async () => {
    const { client, seen } = fakeClient({
      core: () => [CORE_ROW],
      wal: () => [{ files: 3, bytes: 50_331_648 }],
      sizes: () => [SIZES_ROW],
    });

    const metrics = await collectDatabaseMetrics({ client, sizes: "fresh" });

    expect(seen).toEqual(["core", "wal", "sizes"]);
    expect(metrics).toMatchObject({
      xid_age: 1_200_000,
      cache_hit_ratio: 0.99,
      oldest_write_xact_seconds: 4.5,
      oldest_snapshot_seconds: 6,
      stats_cluster_wide: true,
      pg_stat_statements: "ready",
      pg_wal: { readable: true, files: 3, bytes: 50_331_648 },
      sizes: {
        database_bytes: 52_428_800,
        tables: [{ table: "driver_position", total_bytes: 1_048_576 }],
      },
      collection_errors: [],
    });
    expect(metrics.hot_tables).toEqual([
      {
        table: "driver_position",
        partitions: 9,
        n_live_tup: 300,
        n_dead_tup: 100,
        dead_tuple_percent: 25,
        last_autovacuum: "2026-11-15T03:00:00.000Z",
      },
    ]);
    expect(metrics.parameters?.archive_mode).toBe("off");
    // A parameter the server did not answer is null, never missing.
    expect(metrics.parameters?.max_wal_size).toBeNull();
  });

  it("never lists pg_wal for a user who may not", async () => {
    const { client, seen } = fakeClient({
      core: () => [{ ...CORE_ROW, wal_readable: false }],
      sizes: () => [SIZES_ROW],
    });

    const metrics = await collectDatabaseMetrics({ client, sizes: "fresh" });

    expect(seen).toEqual(["core", "sizes"]);
    expect(metrics.pg_wal).toEqual({
      readable: false,
      files: null,
      bytes: null,
    });
    expect(metrics.collection_errors).toEqual([]);
  });

  it("turns a refused part into a collection error and keeps the others", async () => {
    const { client, seen } = fakeClient({
      core: () => {
        throw refusal("57014");
      },
      sizes: () => [SIZES_ROW],
    });

    const metrics = await collectDatabaseMetrics({ client, sizes: "fresh" });

    // Without the first read nobody knows whether pg_wal may be listed.
    expect(seen).toEqual(["core", "sizes"]);
    expect(metrics.collection_errors).toEqual([
      { part: "core", code: "57014" },
    ]);
    expect(metrics.xid_age).toBeNull();
    expect(metrics.archiver).toBeNull();
    expect(metrics.hot_tables).toBeNull();
    expect(metrics.pg_stat_statements).toBeNull();
    expect(metrics.pg_wal.readable).toBeNull();
    expect(metrics.sizes?.database_bytes).toBe(52_428_800);
  });

  it("names the pg_wal and sizes parts on their own", async () => {
    const { client } = fakeClient({
      core: () => [CORE_ROW],
      wal: () => {
        throw refusal("42501");
      },
      sizes: () => {
        throw new Error("socket hang up");
      },
    });

    const metrics = await collectDatabaseMetrics({ client, sizes: "fresh" });

    expect(metrics.collection_errors).toEqual([
      { part: "pg_wal", code: "42501" },
      { part: "sizes", code: null },
    ]);
    expect(metrics.pg_wal).toEqual({
      readable: true,
      files: null,
      bytes: null,
    });
    expect(metrics.sizes).toBeNull();
    expect(metrics.xid_age).toBe(1_200_000);
  });

  it("skips the sizes when asked", async () => {
    const { client, seen } = fakeClient({
      core: () => [CORE_ROW],
      wal: () => [{ files: 1, bytes: 1 }],
    });

    const metrics = await collectDatabaseMetrics({ client, sizes: "skip" });

    expect(seen).toEqual(["core", "wal"]);
    expect(metrics.sizes).toBeNull();
  });

  it("never reports a negative age nor a ratio before the first block", async () => {
    const { client } = fakeClient({
      core: () => [
        {
          ...CORE_ROW,
          blocks_hit: 0,
          blocks_read: 0,
          oldest_write_xact_seconds: -0.002,
          oldest_snapshot_seconds: null,
        },
      ],
      wal: () => [{ files: 0, bytes: 0 }],
    });

    const metrics = await collectDatabaseMetrics({ client, sizes: "skip" });

    expect(metrics.cache_hit_ratio).toBeNull();
    expect(metrics.oldest_write_xact_seconds).toBe(0);
    expect(metrics.oldest_snapshot_seconds).toBeNull();
  });

  it("rounds the hit ratio to four places and survives a missing counter", () => {
    expect(cacheHitRatio(2, 1)).toBe(0.6667);
    expect(cacheHitRatio(null, 1)).toBeNull();
    expect(cacheHitRatio(0, 0)).toBeNull();
  });
});

describe("the five-minute copy of the sizes", () => {
  it("is served until it is five minutes old, then read again", async () => {
    let clock = 1_000_000;
    const memo = createTimedMemo<number>({
      ttlMs: DATABASE_SIZES_TTL_MS,
      now: () => clock,
    });
    const compute = vi.fn(async () => clock);

    expect(DATABASE_SIZES_TTL_MS).toBe(5 * 60 * 1000);
    expect(await memo.read(compute)).toBe(1_000_000);

    clock += DATABASE_SIZES_TTL_MS - 1;
    expect(await memo.read(compute)).toBe(1_000_000);
    expect(compute).toHaveBeenCalledTimes(1);

    clock += 1;
    expect(await memo.read(compute)).toBe(clock);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("never keeps a failure: the next read tries again", async () => {
    const memo = createTimedMemo<string>({ ttlMs: DATABASE_SIZES_TTL_MS });
    const compute = vi
      .fn<[], Promise<string>>()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValue("sizes");

    await expect(memo.read(compute)).rejects.toThrow("timeout");
    expect(await memo.read(compute)).toBe("sizes");
    expect(await memo.read(compute)).toBe("sizes");
    expect(compute).toHaveBeenCalledTimes(2);
  });
});

describe("pg_stat_statements from the catalog", () => {
  it("is ready only when the extension exists and the library is preloaded", () => {
    const state = (installed: boolean, preload: string | null) =>
      pgStatStatementsStateFromCatalog({
        installed,
        sharedPreloadLibraries: preload,
      });

    expect(state(false, "pg_stat_statements")).toBe("missing");
    expect(state(true, "")).toBe("not_loaded");
    expect(state(true, null)).toBe("not_loaded");
    expect(state(true, "pg_stat_statements")).toBe("ready");
  });

  it("finds the library however the list spells it", () => {
    expect(preloadsPgStatStatements("auto_explain, pg_stat_statements")).toBe(
      true,
    );
    expect(preloadsPgStatStatements('"pg_stat_statements"')).toBe(true);
    expect(preloadsPgStatStatements("$libdir/pg_stat_statements.so")).toBe(
      true,
    );
    expect(preloadsPgStatStatements("pg_stat_statements_extra")).toBe(false);
    expect(preloadsPgStatStatements("auto_explain")).toBe(false);
  });
});

/**
 * After the cut of the database roles (plano-escala F3-18), the runtime's
 * login (trajetto_http) may not read the other roles' sessions (no
 * pg_read_all_stats) nor pg_wal (no pg_monitor): the oldest write, the
 * oldest snapshot and pg_wal would read null on /health/metrics. The cron
 * process reads them on the maintenance pool into the cluster row of every
 * minute, and the API takes those parts from there: only those, only from a
 * sample that could read them, only from a recent one.
 */
describe("the cron's cluster sample on /health/metrics", () => {
  const NOW = new Date("2026-11-17T12:00:00Z");

  function live(overrides: Partial<DatabaseMetrics> = {}): DatabaseMetrics {
    return {
      xid_age: 1,
      xid_age_database: 1,
      mxid_age: 1,
      cache_hit_ratio: 0.99,
      blocks_hit: 99,
      blocks_read: 1,
      oldest_write_xact_seconds: null,
      oldest_snapshot_seconds: null,
      oldest_snapshot_xmin_age: null,
      stats_cluster_wide: false,
      archiver: null,
      hot_tables: [],
      parameters: null,
      pg_stat_statements: null,
      pg_wal: { readable: false, files: null, bytes: null },
      sizes: null,
      collection_errors: [],
      ...overrides,
    };
  }

  const sample = (
    ageMs: number,
    overrides: Partial<NonNullable<ClusterDatabaseSample["database"]>> = {},
  ): ClusterDatabaseSample => ({
    ts: new Date(NOW.getTime() - ageMs),
    database: {
      stats_cluster_wide: true,
      oldest_write_xact_seconds: 42,
      oldest_snapshot_seconds: 50,
      oldest_snapshot_xmin_age: 7,
      pg_wal: { readable: true, files: 12, bytes: 12 * 16 * 1024 ** 2 },
      pg_stat_statements: "ready",
      ...overrides,
    },
  });

  it("fills what this login could not read from a recent sample, and says when it was read", () => {
    const merged = mergeClusterSample(live(), sample(60_000), NOW);

    expect(merged).toMatchObject({
      oldest_write_xact_seconds: 42,
      oldest_snapshot_seconds: 50,
      oldest_snapshot_xmin_age: 7,
      stats_cluster_wide: true,
      pg_wal: { readable: true, files: 12 },
      // The preload list needs pg_read_all_settings: unknown live.
      pg_stat_statements: "ready",
      sampled_at: "2026-11-17T11:59:00.000Z",
      // The rest stays live.
      cache_hit_ratio: 0.99,
    });
  });

  it("keeps a live reading that could see everything, as today's superuser", () => {
    const superuser = live({
      stats_cluster_wide: true,
      oldest_write_xact_seconds: 1,
      pg_wal: { readable: true, files: 3, bytes: 3 },
      pg_stat_statements: "not_loaded",
    });

    expect(mergeClusterSample(superuser, sample(60_000), NOW)).toBe(superuser);
  });

  it("ignores a sample that is too old, absent, or could not read either", () => {
    expect(
      mergeClusterSample(live(), sample(CLUSTER_SAMPLE_MAX_AGE_MS + 1), NOW),
    ).toEqual(live());
    expect(mergeClusterSample(live(), null, NOW)).toEqual(live());
    expect(
      mergeClusterSample(
        live(),
        sample(60_000, {
          stats_cluster_wide: false,
          pg_wal: { readable: false, files: null, bytes: null },
          pg_stat_statements: null,
        }),
        NOW,
      ),
    ).toEqual(live());
  });

  it("leaves pg_stat_statements unknown, not 'not_loaded', when the preload list is unreadable", async () => {
    const withoutPreload = {
      ...CORE_ROW,
      parameters: Object.fromEntries(
        Object.entries(CORE_ROW.parameters ?? {}).filter(
          ([name]) => name !== "shared_preload_libraries",
        ),
      ),
    };
    const client = {
      $queryRaw: vi.fn(async (sql: Sql) =>
        partOf(sql) === "core" ? [withoutPreload] : [],
      ),
    } as unknown as Client;

    const metrics = await collectDatabaseMetrics({ client, sizes: "skip" });

    expect(metrics.pg_stat_statements).toBeNull();
    expect(metrics.parameters?.shared_preload_libraries).toBeNull();
  });

  it("reads the sample only when the live reading needs it, and survives a refusal", async () => {
    const $queryRaw = vi.fn(async () => [sample(60_000)]);
    const client = { $queryRaw } as unknown as Client;
    const superuser = live({
      stats_cluster_wide: true,
      pg_wal: { readable: true, files: 1, bytes: 1 },
      pg_stat_statements: "ready",
    });

    expect(await withClusterSample(superuser, client, NOW)).toBe(superuser);
    expect($queryRaw).not.toHaveBeenCalled();

    expect((await withClusterSample(live(), client, NOW)).sampled_at).toBe(
      "2026-11-17T11:59:00.000Z",
    );
    expect($queryRaw).toHaveBeenCalledTimes(1);

    const refusing = {
      $queryRaw: vi.fn(async () => {
        throw new Error("relation ops_sample: permission denied");
      }),
    } as unknown as Client;

    expect(await withClusterSample(live(), refusing, NOW)).toEqual(live());
  });
});
