import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { PartialRunError } from "@/shared/errors/partial-run-error";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The retention of the scale plan's series (plano-escala F1-13): ops_sample
 * (one row per process per minute, F1-08/F1-10) and pgss_snapshot (200 rows
 * an hour, F1-12) are kept 30 days by default, purged every night at 04:40
 * UTC in batches, with the partial run of F1-17 when a run stops with rows
 * still due.
 *
 * What this pins, on the real tables: a row of 31 days goes and one of 29
 * stays, in both; a run that stops at its ceiling with rows left ends
 * partial, after purging what it could of both.
 */
const prisma = createPrismaClient();

const DAY_MS = 24 * 60 * 60 * 1000;

afterAll(async () => {
  await prisma.$disconnect();
});

const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);

async function seedSample(ts: Date, replica: string): Promise<void> {
  await prisma.opsSample.create({
    data: { ts, role: "all", replica, metrics: { v: 1 } },
  });
}

async function seedSnapshot(takenAt: Date, queryid: bigint): Promise<void> {
  await prisma.pgssSnapshot.create({
    data: {
      taken_at: takenAt,
      period_start: new Date(takenAt.getTime() - 3_600_000),
      basis: "previous",
      userid: 10n,
      toplevel: true,
      queryid,
      query: "SELECT $1",
      calls: 1n,
      total_exec_time_ms: 1,
      total_plan_time_ms: 0,
      max_exec_time_ms: 1,
      rows: 1n,
      shared_blks_hit: 0n,
      shared_blks_read: 0n,
      shared_blks_dirtied: 0n,
      shared_blks_written: 0n,
      temp_blks_written: 0n,
      wal_bytes: 0n,
    },
  });
}

async function replicasLeft(): Promise<string[]> {
  const rows = await prisma.opsSample.findMany({
    select: { replica: true },
    orderBy: { replica: "asc" },
  });

  return rows.map((row) => row.replica);
}

async function queryidsLeft(): Promise<bigint[]> {
  const rows = await prisma.pgssSnapshot.findMany({
    select: { queryid: true },
    orderBy: { queryid: "asc" },
  });

  return rows.map((row) => row.queryid);
}

beforeEach(async () => {
  await prisma.opsSample.deleteMany({});
  await prisma.pgssSnapshot.deleteMany({});
});

describe("the retention of the operation series", () => {
  it("purges a row of 31 days and keeps one of 29, in both series", async () => {
    await seedSample(daysAgo(31), "old");
    await seedSample(daysAgo(29), "recent");
    await seedSnapshot(daysAgo(31), 1n);
    await seedSnapshot(daysAgo(29), 2n);

    const { purgeOpsSeriesJob } =
      await import("@/jobs/cron/purge-ops-series-job");

    await purgeOpsSeriesJob.handler();

    expect(await replicasLeft()).toEqual(["recent"]);
    expect(await queryidsLeft()).toEqual([2n]);
  });

  it("ends partial when a run stops with rows still due, after both purges", async () => {
    await seedSample(daysAgo(40), "old-1");
    await seedSample(daysAgo(35), "old-2");
    await seedSample(daysAgo(1), "recent");
    await seedSnapshot(daysAgo(40), 1n);
    await seedSnapshot(daysAgo(1), 2n);

    const { runOpsSeriesPurge } =
      await import("@/jobs/cron/purge-ops-series-job");

    const run = runOpsSeriesPurge({ maxRows: 1 });

    await expect(run).rejects.toBeInstanceOf(PartialRunError);
    await expect(run).rejects.toThrow(/ops_sample/);

    // The oldest went first; the snapshot purge still ran.
    expect(await replicasLeft()).toEqual(["old-2", "recent"]);
    expect(await queryidsLeft()).toEqual([2n]);
  });
});
