import { afterAll, describe, expect, it } from "vitest";

import { snapshotQueryStats } from "@/jobs/cron/snapshot-query-stats-job";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The hourly pg_stat_statements snapshot (plano-escala F1-12), against a
 * server that preloads the library (the E2E jobs of validate.yml; locally,
 * the command in docs/testes.md).
 *
 * The view is cumulative and the whole server's. What this pins, on the
 * real view:
 *
 *  - the first run writes what the view holds since its reset, and the
 *    second run only what ran in between: a statement run 20 times, then
 *    10, is 10 in the second run;
 *  - a reset (stats_reset moved) and a statement whose counters went
 *    backwards (here, this database's entries reset) are never subtracted
 *    into a negative number;
 *  - only this database's statements count: the view lists every database
 *    of the server, and the E2E files run side by side on one.
 */
const prisma = createPrismaClient();

const MARKER = "pgss_snapshot_e2e_marker";

afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * A statement nothing else runs, `times` times. Many calls keep its entry
 * from being the one evicted: the E2E files beside this one fill the view
 * (pg_stat_statements.max) with their own databases' statements.
 */
async function runMarker(times: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    await prisma.$queryRawUnsafe(`SELECT $1::int AS ${MARKER}`, i);
  }
}

/** A run of its own, far from now, on the hour's :13. */
const BASE_HOUR =
  Date.UTC(2026, 0, 1, 0, 13) + Math.floor(Math.random() * 1e5) * 3_600_000;

const hour = (n: number) => new Date(BASE_HOUR + n * 3_600_000);

interface SnapshotRow {
  basis: string;
  calls: number;
  query: string | null;
  period_start: Date;
}

async function markerRows(takenAt: Date): Promise<SnapshotRow[]> {
  return prisma.$queryRaw<SnapshotRow[]>`
    SELECT basis, calls::int AS calls, query, period_start
    FROM pgss_snapshot
    WHERE taken_at = ${takenAt} AND strpos(query, ${MARKER}) > 0
  `;
}

/** The smallest time the run wrote. */
async function smallestTime(takenAt: Date): Promise<number> {
  const [row] = await prisma.$queryRaw<Array<{ least: number }>>`
    SELECT least(min(total_exec_time_ms), min(total_plan_time_ms))::float8
      AS least
    FROM pgss_snapshot
    WHERE taken_at = ${takenAt}
  `;

  return row.least;
}

/** The smallest of every counter the run wrote. */
async function smallestCounter(takenAt: Date): Promise<number> {
  const [row] = await prisma.$queryRaw<Array<{ least: number }>>`
    SELECT least(
      min(calls), min(rows), min(shared_blks_hit), min(shared_blks_read),
      min(shared_blks_dirtied), min(shared_blks_written),
      min(temp_blks_written), min(wal_bytes)
    )::float8 AS least
    FROM pgss_snapshot
    WHERE taken_at = ${takenAt}
  `;

  return row.least;
}

describe("the hourly pg_stat_statements snapshot", () => {
  it("writes, from the second run on, only what ran in between", async () => {
    await runMarker(20);

    const first = await snapshotQueryStats({ takenAt: hour(0) });

    // No state yet: the view as it is, since its reset.
    expect(first.reset).toBe(true);
    expect(await markerRows(hour(0))).toEqual([
      expect.objectContaining({ basis: "reset", calls: 20 }),
    ]);

    await runMarker(10);

    const second = await snapshotQueryStats({ takenAt: hour(1) });

    expect(second.reset).toBe(false);
    expect(second.written).toBeLessThanOrEqual(200);

    const [row] = await markerRows(hour(1));

    expect(row).toMatchObject({
      basis: "previous",
      calls: 10,
      period_start: hour(0),
    });
    // The text of the chosen statements only, and never more than 4 KB.
    expect(row.query).toContain(MARKER);

    const state = await prisma.pgssState.findUnique({ where: { id: 1 } });

    expect(state?.taken_at).toEqual(hour(1));
  });

  it("never writes a negative number after a reset", async () => {
    // A reset moves stats_reset: the run sees a value other than the one
    // it recorded. A real one would reset the whole server's statistics
    // under the files running beside this one.
    await prisma.$executeRaw`
      UPDATE pgss_state SET stats_reset = '2000-01-01T00:00:00Z'
    `;
    await runMarker(5);

    const outcome = await snapshotQueryStats({ takenAt: hour(2) });

    expect(outcome.reset).toBe(true);
    // 20 + 10 + 5 since the (real) reset: nothing subtracted.
    expect(await markerRows(hour(2))).toEqual([
      expect.objectContaining({ basis: "reset", calls: 35 }),
    ]);
    expect(await smallestCounter(hour(2))).toBeGreaterThanOrEqual(0);
    expect(await smallestTime(hour(2))).toBeGreaterThanOrEqual(0);
  });

  it("takes a statement whose counters went backwards as the delta", async () => {
    // This database's entries only: the counters start over below the
    // baseline the previous run left, as after an eviction.
    // It returns void on PG16, which a raw query cannot read back.
    await prisma.$executeRaw`
      SELECT pg_stat_statements_reset(
        0, (SELECT oid FROM pg_database WHERE datname = current_database()), 0
      )
    `;
    await runMarker(5);

    const outcome = await snapshotQueryStats({ takenAt: hour(3) });

    expect(outcome.reset).toBe(false);
    expect(await markerRows(hour(3))).toEqual([
      expect.objectContaining({ basis: "recreated", calls: 5 }),
    ]);
    expect(await smallestCounter(hour(3))).toBeGreaterThanOrEqual(0);
    expect(await smallestTime(hour(3))).toBeGreaterThanOrEqual(0);
  });

  it("keeps only the top N of the hour", async () => {
    await runMarker(1);

    const outcome = await snapshotQueryStats({ takenAt: hour(4), top: 1 });

    expect(outcome.written).toBe(1);

    const [{ n }] = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pgss_snapshot WHERE taken_at = ${hour(4)}
    `;

    expect(n).toBe(1);
  });
});
