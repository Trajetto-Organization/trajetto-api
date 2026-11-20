import { describe, expect, it, vi } from "vitest";

import type { Prisma } from "@prisma/client";

import {
  collectDatabaseMetrics,
  resetIndexUsageCache,
} from "@/shared/health/database-metrics";
import {
  INDEX_USAGE_WINDOW_DAYS,
  indexUsageOf,
  type IndexUsageRow,
} from "@/shared/health/index-usage";
import { indexUsageSql } from "@/shared/health/metrics-queries";

/**
 * The index usage report of /health/metrics (plano-escala F2-23).
 *
 * An index nobody reads still costs every write of its table, and the hot
 * tables are written all day. The report lists each index of the hot
 * tables with its scans and its last scan (Postgres 16), so an index can
 * be cut once 30 days of production show nobody reads it. Why each case:
 * a primary key or a unique is never a candidate (an upsert or a
 * constraint needs it whatever the scans say); an index whose window is
 * shorter than 30 days, or unknown, is never one either (a new index, or
 * counters reset last week, has not had its chance); and a refused read
 * must not blank the rest of the database block.
 */
const NOW = new Date("2026-12-30T12:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) =>
  new Date(NOW.getTime() - days * DAY_MS).toISOString();

function row(overrides: Partial<IndexUsageRow> = {}): IndexUsageRow {
  return {
    table_name: "route_stop",
    index_name: "route_stop_some_idx",
    scans: 0,
    last_scan_at: null,
    bytes: 8192,
    is_primary: false,
    is_unique: false,
    ...overrides,
  };
}

describe("indexUsageOf", () => {
  it("flags a plain index never scanned in a window of 30 days or more", () => {
    const usage = indexUsageOf(
      { stats_reset_at: daysAgo(31), indexes: [row()] },
      NOW,
    );

    expect(INDEX_USAGE_WINDOW_DAYS).toBe(30);
    expect(usage.window_days).toBe(31);
    expect(usage.indexes).toEqual([
      {
        table: "route_stop",
        index: "route_stop_some_idx",
        scans: 0,
        last_scan_at: null,
        bytes: 8192,
        primary: false,
        unique: false,
        unused: true,
      },
    ]);
    expect(usage.unused).toEqual(["route_stop_some_idx"]);
    expect(usage.measured_at).toBe(NOW.toISOString());
  });

  it("flags one whose last scan is older than 30 days, whatever the window", () => {
    const usage = indexUsageOf(
      {
        stats_reset_at: null,
        indexes: [row({ scans: 12, last_scan_at: daysAgo(45) })],
      },
      NOW,
    );

    expect(usage.unused).toEqual(["route_stop_some_idx"]);
  });

  it("never flags a primary key, a unique, a recent scan or a short window", () => {
    const usage = indexUsageOf(
      {
        stats_reset_at: daysAgo(40),
        indexes: [
          row({ index_name: "pk", is_primary: true, is_unique: true }),
          row({ index_name: "uq", is_unique: true }),
          row({ index_name: "used", scans: 3, last_scan_at: daysAgo(2) }),
        ],
      },
      NOW,
    );

    expect(usage.unused).toEqual([]);

    // Counters reset ten days ago: no index has had its 30 days yet.
    const short = indexUsageOf(
      { stats_reset_at: daysAgo(10), indexes: [row()] },
      NOW,
    );

    expect(short.window_days).toBe(10);
    expect(short.unused).toEqual([]);

    // Never reset: since when the counters run is unknown, so a zero
    // proves nothing (an index created yesterday reads zero too).
    const unknown = indexUsageOf(
      { stats_reset_at: null, indexes: [row()] },
      NOW,
    );

    expect(unknown.window_days).toBeNull();
    expect(unknown.unused).toEqual([]);
  });

  it("turns a driver's strings and nulls into numbers, never NaN", () => {
    const usage = indexUsageOf(
      {
        stats_reset_at: daysAgo(31),
        indexes: [
          row({
            scans: "7" as unknown as number,
            bytes: null as unknown as number,
          }),
        ],
      },
      NOW,
    );

    expect(usage.indexes[0]).toMatchObject({ scans: 7, bytes: 0 });
  });
});

describe("the index usage in the database block", () => {
  type Client = Pick<Prisma.TransactionClient, "$queryRaw">;

  function client(indexes: () => unknown[]) {
    const seen: string[] = [];
    const $queryRaw = vi.fn(async (sql: Prisma.Sql) => {
      if (sql.sql.includes("pg_stat_user_indexes")) {
        seen.push("index_usage");

        return indexes();
      }

      seen.push("core");

      return [{ wal_readable: false }];
    });

    return { client: { $queryRaw } as unknown as Client, seen };
  }

  it("is read only when asked, once per copy, and a refusal is a collection error", async () => {
    resetIndexUsageCache();

    const skipped = client(() => []);
    const plain = await collectDatabaseMetrics({
      client: skipped.client,
      sizes: "skip",
    });

    expect(skipped.seen).toEqual(["core"]);
    expect(plain.index_usage).toBeUndefined();

    // The block reads the clock itself: a reset 31 real days ago.
    const read = client(() => [
      {
        stats_reset_at: new Date(Date.now() - 31 * DAY_MS).toISOString(),
        indexes: [row()],
      },
    ]);
    const first = await collectDatabaseMetrics({
      client: read.client,
      sizes: "skip",
      indexUsage: "cached",
    });

    expect(first.index_usage?.unused).toEqual(["route_stop_some_idx"]);

    await collectDatabaseMetrics({
      client: read.client,
      sizes: "skip",
      indexUsage: "cached",
    });

    // The second answer came from the copy.
    expect(read.seen).toEqual(["core", "index_usage", "core"]);

    resetIndexUsageCache();

    const refused = client(() => {
      throw Object.assign(new Error("refused"), {
        code: "P2010",
        meta: { code: "42501" },
      });
    });
    const failed = await collectDatabaseMetrics({
      client: refused.client,
      sizes: "skip",
      indexUsage: "cached",
    });

    expect(failed.index_usage).toBeNull();
    expect(failed.collection_errors).toEqual([
      { part: "index_usage", code: "42501" },
    ]);
  });

  it("reads the hot tables' indexes by their roots, with the last scan when the server has it", () => {
    const sql = indexUsageSql().sql;

    expect(sql).toContain("pg_stat_user_indexes");
    expect(sql).toContain("pg_partition_root");
    // Through the row as JSON: a server before 16 has no last_idx_scan,
    // and naming the column would fail the whole read there.
    expect(sql).toContain("'last_idx_scan'");
    expect(sql).toContain("stats_reset");
  });
});
