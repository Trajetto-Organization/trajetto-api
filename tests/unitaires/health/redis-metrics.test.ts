import { describe, expect, it } from "vitest";

import { parseRedisInfo, readRedisMetrics } from "@/shared/health/redis-metrics";

/**
 * Redis on /health/metrics (contract §32): the API survives Redis being down
 * (fail-open), so the read reports and never throws, and a hung Redis never
 * holds the metrics endpoint.
 */
const INFO = [
  "# Server",
  "redis_version:7.2.4",
  "uptime_in_seconds:3600",
  "# Clients",
  "connected_clients:42",
  "blocked_clients:0",
  "# Memory",
  "used_memory:104857600",
  "maxmemory:268435456",
  "# Stats",
  "rejected_connections:0",
  "evicted_keys:7",
].join("\r\n");

describe("the Redis metrics", () => {
  it("parses INFO into fields", () => {
    const fields = parseRedisInfo(INFO);

    expect(fields.get("connected_clients")).toBe("42");
    expect(fields.has("# Memory")).toBe(false);
  });

  it("reports latency and the INFO numbers in MB", async () => {
    const metrics = await readRedisMetrics(async () => ({
      ping: async () => "PONG",
      info: async () => INFO,
    }));

    expect(metrics).toMatchObject({
      status: "up",
      used_memory_mb: 100,
      maxmemory_mb: 256,
      connected_clients: 42,
      evicted_keys: 7,
      uptime_seconds: 3600,
    });
    expect(metrics.latency_ms).not.toBeNull();
  });

  it("says no ceiling (null) for maxmemory 0", async () => {
    const metrics = await readRedisMetrics(async () => ({
      ping: async () => "PONG",
      info: async () => "maxmemory:0\r\nused_memory:1048576",
    }));

    expect(metrics.maxmemory_mb).toBeNull();
    expect(metrics.used_memory_mb).toBe(1);
  });

  it("is down, quickly, when Redis hangs", async () => {
    const startedAt = Date.now();

    const metrics = await readRedisMetrics(
      async () => ({ ping: () => new Promise(() => undefined), info: async () => INFO }),
      50,
    );

    expect(metrics.status).toBe("down");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("is down when the client cannot be had", async () => {
    const metrics = await readRedisMetrics(async () => {
      throw new Error("ECONNREFUSED");
    });

    expect(metrics.status).toBe("down");
  });
});
