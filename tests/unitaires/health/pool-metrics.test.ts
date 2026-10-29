import { describe, expect, it } from "vitest";

import {
  connectionLimitOf,
  poolFromStats,
  poolLimitOf,
  readPrismaPool,
} from "@/shared/health/pool-metrics";

/**
 * The connection pool of this replica (OBS-11, GAP3-10).
 *
 * The card showed pg_stat_activity against max_connections — two replicas of
 * ten against a hundred reads 20%, "Saudável", while each replica's own pool
 * is full and requests queue for a connection. The pool is what saturates
 * first, and the ADR 0001/0004 triggers are written in its terms.
 *
 * Under Prisma 7 the numbers come from the pg Pool behind the driver adapter
 * (Prisma's `metrics` preview was removed); the fields keep their meaning.
 */
function pgPool(
  totalCount: number,
  idleCount: number,
  waitingCount: number,
  max = 10,
) {
  return { totalCount, idleCount, waitingCount, options: { max } };
}

describe("poolFromStats", () => {
  it("reads a saturated pool: every connection busy, queries waiting", () => {
    expect(poolFromStats(pgPool(10, 0, 7))).toEqual({
      open: 10,
      busy: 10,
      idle: 0,
      waiting: 7,
    });
  });

  it("counts as busy what is open and not idle", () => {
    expect(poolFromStats(pgPool(4, 3, 0))).toEqual({
      open: 4,
      busy: 1,
      idle: 3,
      waiting: 0,
    });
  });

  it("reads zeros before the first query, when there is no pool yet", () => {
    expect(poolFromStats(null)).toEqual({
      open: 0,
      busy: 0,
      idle: 0,
      waiting: 0,
    });
  });

  it("never reports a negative or non-numeric count", () => {
    expect(
      poolFromStats({
        totalCount: Number.NaN,
        idleCount: 2,
        waitingCount: -1,
        options: {},
      }),
    ).toEqual({ open: 0, busy: 0, idle: 2, waiting: 0 });
  });
});

describe("poolLimitOf", () => {
  it("is the pool's own max once the pool exists", () => {
    expect(
      poolLimitOf(
        pgPool(0, 0, 0, 1),
        "postgresql://u:p@db:5432/d?connection_limit=10",
      ),
    ).toBe(1);
  });

  it("is the URL's connection_limit before the first query", () => {
    expect(
      poolLimitOf(null, "postgresql://u:p@db:5432/d?connection_limit=10"),
    ).toBe(10);
    expect(poolLimitOf(null, "postgresql://u:p@db:5432/d")).toBeNull();
  });
});

describe("readPrismaPool", () => {
  it("joins the limit and the counts, as runtime.prisma_pool", async () => {
    expect(
      await readPrismaPool(
        () => pgPool(10, 1, 2),
        "postgresql://u:p@db:5432/d?connection_limit=10",
      ),
    ).toEqual({ limit: 10, open: 10, busy: 9, idle: 1, waiting: 2 });
  });
});

describe("connectionLimitOf", () => {
  it("reads connection_limit from the URL", () => {
    expect(
      connectionLimitOf(
        "postgresql://u:p@db:5432/d?schema=public&connection_limit=10",
      ),
    ).toBe(10);
  });

  it("is null when the URL does not set it", () => {
    expect(
      connectionLimitOf("postgresql://u:p@db:5432/d?schema=public"),
    ).toBeNull();
    expect(connectionLimitOf(undefined)).toBeNull();
  });
});
