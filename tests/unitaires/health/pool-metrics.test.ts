import { describe, expect, it } from "vitest";

import {
  connectionLimitOf,
  poolFromMetrics,
} from "@/shared/health/pool-metrics";

/**
 * The Prisma pool of this replica, from `$metrics.json()` (OBS-11, GAP3-10).
 *
 * The card showed pg_stat_activity against max_connections — two replicas of
 * ten against a hundred reads 20%, "Saudável", while each replica's own pool
 * is full and requests queue for a connection. The pool is what saturates
 * first, and the ADR 0001/0004 triggers are written in its terms.
 */
const SAMPLE = {
  counters: [
    {
      key: "prisma_pool_connections_opened_total",
      value: 12,
      labels: {},
      description: "",
    },
  ],
  gauges: [
    {
      key: "prisma_client_queries_active",
      value: 10,
      labels: {},
      description: "",
    },
    {
      key: "prisma_client_queries_wait",
      value: 7,
      labels: {},
      description: "",
    },
    {
      key: "prisma_pool_connections_busy",
      value: 10,
      labels: {},
      description: "",
    },
    {
      key: "prisma_pool_connections_idle",
      value: 0,
      labels: {},
      description: "",
    },
    {
      key: "prisma_pool_connections_open",
      value: 10,
      labels: {},
      description: "",
    },
  ],
  histograms: [
    {
      key: "prisma_client_queries_wait_histogram_ms",
      value: { buckets: [], sum: 5400, count: 120 },
      labels: {},
      description: "",
    },
  ],
};

describe("poolFromMetrics", () => {
  it("reads the pool gauges", () => {
    expect(poolFromMetrics(SAMPLE)).toEqual({
      open: 10,
      busy: 10,
      idle: 0,
      waiting: 7,
    });
  });

  it("reads zero for a gauge a Prisma version does not report", () => {
    expect(
      poolFromMetrics({ counters: [], gauges: [], histograms: [] }),
    ).toEqual({
      open: 0,
      busy: 0,
      idle: 0,
      waiting: 0,
    });
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

  it("is null when the URL leaves it to Prisma's default", () => {
    expect(
      connectionLimitOf("postgresql://u:p@db:5432/d?schema=public"),
    ).toBeNull();
    expect(connectionLimitOf(undefined)).toBeNull();
  });
});
