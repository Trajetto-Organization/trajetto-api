import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  parseRedisInfo,
  readRedisMetrics,
} from "@/shared/health/redis-metrics";

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

/**
 * The INFO of a real Redis 7.4.12 (the version of the CI and of the Dokploy
 * Databases), as ioredis' `info()` reads it: the default sections, with a
 * 256 MB ceiling, allkeys-lru and one pattern subscription. Only the run id,
 * the replication id and the kernel were blanked; nothing in it is an
 * address or a key.
 */
const INFO_7_4 = readFileSync(
  resolve(__dirname, "fixtures", "redis-info-7.4.txt"),
  "utf8",
).replace(/\r?\n/g, "\r\n");

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

  it("reads the rate, CPU, pub/sub, output, buffers, policy and evictions of a real 7.4 INFO", async () => {
    // What the scale plan reads from Redis (F1-07): how busy it is (ops/s,
    // CPU seconds), what the Socket.IO adapter holds (pub/sub), what it sends
    // (output bytes and rate), what the clients' buffers hold, and whether
    // it may throw keys away (policy, evictions).
    const metrics = await readRedisMetrics(async () => ({
      ping: async () => "PONG",
      info: async () => INFO_7_4,
    }));

    expect(metrics).toEqual({
      status: "up",
      latency_ms: expect.any(Number),
      used_memory_mb: 1,
      maxmemory_mb: 256,
      connected_clients: 2,
      blocked_clients: 0,
      rejected_connections: 0,
      evicted_keys: 0,
      uptime_seconds: 518,
      ops_per_sec: 1,
      used_cpu_sys_seconds: 0.434,
      used_cpu_user_seconds: 1.883,
      pubsub_channels: 0,
      pubsub_patterns: 1,
      total_net_output_bytes: 688,
      output_kbps: 0.03,
      mem_clients_normal_bytes: 22456,
      client_recent_max_output_buffer_bytes: 0,
      maxmemory_policy: "allkeys-lru",
      evicted_clients: 0,
    });
  });

  it("leaves a field null when this Redis does not report it", async () => {
    // An older server, or a section ioredis did not return: the field is
    // unknown, never zero.
    const metrics = await readRedisMetrics(async () => ({
      ping: async () => "PONG",
      info: async () => INFO,
    }));

    expect(metrics).toMatchObject({
      ops_per_sec: null,
      used_cpu_sys_seconds: null,
      pubsub_patterns: null,
      maxmemory_policy: null,
      evicted_clients: null,
    });
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
      async () => ({
        ping: () => new Promise(() => undefined),
        info: async () => INFO,
      }),
      50,
    );

    expect(metrics.status).toBe("down");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("is down when the client cannot be had, with every field null", async () => {
    const metrics = await readRedisMetrics(async () => {
      throw new Error("ECONNREFUSED");
    });

    expect(metrics.status).toBe("down");

    const { status: _status, ...fields } = metrics;
    expect(Object.values(fields).every((value) => value === null)).toBe(true);
    expect(Object.keys(fields)).toHaveLength(19);
  });
});
