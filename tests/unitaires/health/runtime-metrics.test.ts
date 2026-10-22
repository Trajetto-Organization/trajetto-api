import { describe, expect, it } from "vitest";

import { createRuntimeMetrics } from "@/shared/health/runtime-metrics";

/**
 * What saturates first inside a replica (GAP3-10).
 *
 * /health/metrics described the database and the queues and nothing of the
 * process serving them: no event-loop lag, no loop utilisation, nothing on
 * libuv's threadpool (bcrypt, gzip, DNS and fs share its four threads), no
 * Prisma pool. A burst of logins or a synchronous parse that stalled a replica
 * for half a second looked, from outside, like "the database is slow" — and
 * the fix reached for was a bigger database or a broker.
 */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("createRuntimeMetrics", () => {
  it("sees a blocked event loop, its utilisation and the threadpool", async () => {
    const metrics = createRuntimeMetrics({
      windowMs: 1_000,
      canaryIntervalMs: 20,
    });

    metrics.start();

    try {
      await sleep(60);

      // A synchronous stall, like a big XML parse on the request path.
      const blockedAt = Date.now();
      while (Date.now() - blockedAt < 200) {
        // busy
      }

      await sleep(100);

      const snapshot = metrics.snapshot();

      expect(snapshot.event_loop.lag_max_ms).toBeGreaterThanOrEqual(150);
      expect(snapshot.event_loop.lag_p99_ms).not.toBeNull();
      expect(snapshot.event_loop.utilization).toBeGreaterThan(0);
      expect(snapshot.event_loop.utilization).toBeLessThanOrEqual(1);

      expect(snapshot.threadpool.canary_last_ms).not.toBeNull();
      expect(snapshot.threadpool.size).toBeGreaterThan(0);

      expect(snapshot.memory.rss_mb).toBeGreaterThan(0);
      expect(typeof snapshot.replica).toBe("string");
    } finally {
      metrics.stop();
    }
  });

  it("starts a fresh window on rotate", async () => {
    const metrics = createRuntimeMetrics({
      windowMs: 1_000,
      canaryIntervalMs: 20,
    });

    metrics.start();

    try {
      // Let the delay monitor take its first samples before the stall.
      await sleep(60);

      const blockedAt = Date.now();
      while (Date.now() - blockedAt < 150) {
        // busy
      }

      await sleep(50);

      const first = metrics.rotate();
      expect(first.event_loop.lag_max_ms).toBeGreaterThanOrEqual(100);

      await sleep(80);

      const second = metrics.snapshot();
      expect(second.event_loop.lag_max_ms ?? 0).toBeLessThan(100);
    } finally {
      metrics.stop();
    }
  });

  it("answers before it was started, with nulls where it has not measured", () => {
    const metrics = createRuntimeMetrics();

    const snapshot = metrics.snapshot();

    expect(snapshot.event_loop.lag_p99_ms).toBeNull();
    expect(snapshot.threadpool.canary_last_ms).toBeNull();
    expect(typeof snapshot.event_loop.utilization).toBe("number");
  });
});
