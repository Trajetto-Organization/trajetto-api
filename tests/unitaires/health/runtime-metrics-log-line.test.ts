import { afterEach, describe, expect, it, vi } from "vitest";

import { readPrismaPool } from "@/shared/health/pool-metrics";
import {
  createRuntimeMetrics,
  startRuntimeMetrics,
} from "@/shared/health/runtime-metrics";

/**
 * The once-a-minute "runtime metrics" line carries the replica's Prisma pool
 * (GAP3-10, OBS-11).
 *
 * /health/metrics answers for the ONE replica the sticky cookie picked, so the
 * log line is the only place every replica's numbers show up — and the pool
 * is the ADR 0001/0004 trigger ("waiting > 0 for a minute"). The line had the
 * event loop, the threadpool and memory, and no pool: an alert set up on
 * `runtime.prisma_pool.waiting`, as the runbook says, would never have fired.
 */
interface Line {
  fields: { runtime: Record<string, unknown> };
  message: string;
}

function collector() {
  const lines: Line[] = [];

  return {
    lines,
    log: {
      info(fields: Record<string, unknown>, message: string) {
        lines.push({ fields: fields as Line["fields"], message });
      },
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("startRuntimeMetrics", () => {
  it("logs this replica's Prisma pool in the minute line", async () => {
    vi.useFakeTimers();

    const { lines, log } = collector();
    const metrics = createRuntimeMetrics({ windowMs: 1_000, canaryIntervalMs: 60_000 });

    const pool = { limit: 10, open: 10, busy: 10, idle: 0, waiting: 3 };
    const stop = startRuntimeMetrics(log, metrics, async () => pool);

    try {
      await vi.advanceTimersByTimeAsync(1_000);
    } finally {
      stop();
    }

    expect(lines).toHaveLength(1);
    expect(lines[0].message).toBe("runtime metrics");
    expect(lines[0].fields.runtime.prisma_pool).toEqual(pool);
    expect(lines[0].fields.runtime.event_loop).toBeDefined();
  });

  it("reads the pool as /health/metrics shows it", async () => {
    const source = {
      $metrics: {
        json: async () => ({
          counters: [],
          gauges: [
            { key: "prisma_pool_connections_open", value: 10 },
            { key: "prisma_pool_connections_busy", value: 9 },
            { key: "prisma_pool_connections_idle", value: 1 },
            { key: "prisma_client_queries_wait", value: 2 },
          ],
          histograms: [],
        }),
      },
    };

    expect(
      await readPrismaPool(source, "postgresql://u:p@db:5432/d?connection_limit=10"),
    ).toEqual({ limit: 10, open: 10, busy: 9, idle: 1, waiting: 2 });
  });

  it("still logs the line when the pool cannot be read", async () => {
    vi.useFakeTimers();

    const { lines, log } = collector();
    const metrics = createRuntimeMetrics({ windowMs: 1_000, canaryIntervalMs: 60_000 });

    const stop = startRuntimeMetrics(log, metrics, async () => {
      throw new Error("metrics preview renamed");
    });

    try {
      await vi.advanceTimersByTimeAsync(1_000);
    } finally {
      stop();
    }

    expect(lines).toHaveLength(1);
    expect(lines[0].fields.runtime.prisma_pool).toBeNull();
    expect(lines[0].fields.runtime.memory).toBeDefined();
  });
});
