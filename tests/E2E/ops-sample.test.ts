import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it, vi } from "vitest";

import { createPrismaClient } from "@/shared/database/database-client";
import {
  buildOpsSampleRow,
  createOpsSampler,
  createSampleSections,
  insertOpsSample,
} from "@/shared/health/ops-sample";
import {
  createRuntimeMetrics,
  startRuntimeMetrics,
} from "@/shared/health/runtime-metrics";

/**
 * The per-minute ops_sample row reaches the table and reads back as written
 * (plano-escala F1-08): the migration's columns, the document's version and
 * the numbers a trigger is judged on (`metrics->'event_loop'->>'utilization'`,
 * `metrics->'prisma_pool'->>'waiting'`), from the real runtime collector
 * through the sampler, against the migrated database.
 */
const prisma = createPrismaClient();

afterAll(async () => {
  await prisma.$disconnect();
});

interface Row {
  id: string;
  ts: Date;
  role: string;
  replica: string;
  commit: string | null;
  v: number;
  utilization: number;
  waiting: number | null;
  realtime: unknown;
}

async function rowsOf(replica: string): Promise<Row[]> {
  return prisma.$queryRaw<Row[]>`
    SELECT
      id, ts, role, replica, commit,
      (metrics->>'v')::int AS v,
      (metrics->'event_loop'->>'utilization')::float8 AS utilization,
      (metrics->'prisma_pool'->>'waiting')::int AS waiting,
      metrics->'realtime' AS realtime
    FROM ops_sample
    WHERE replica = ${replica}
    ORDER BY ts
  `;
}

describe("ops_sample", () => {
  it("stores a row as built, with a time-ordered id", async () => {
    const replica = `e2e-${randomUUID()}`;
    const endedAt = new Date("2026-11-15T12:01:00.000Z");

    await insertOpsSample(
      buildOpsSampleRow(
        {
          endedAt,
          runtime: {
            replica,
            window_seconds: 60,
            event_loop: {
              lag_p50_ms: 10,
              lag_p99_ms: 20,
              lag_max_ms: 30,
              utilization: 0.25,
            },
            threadpool: { size: 8, canary_last_ms: 1, canary_max_ms: 2 },
            memory: { rss_mb: 200, heap_used_mb: 100 },
            prisma_pool: { limit: 10, open: 2, busy: 1, idle: 1, waiting: 3 },
          },
          providers: [],
        },
        { role: "http", replica, commit: "abc1234" },
        { realtime: { local_connections: 5 } },
      ),
    );

    const [row] = await rowsOf(replica);

    expect(row).toMatchObject({
      ts: endedAt,
      role: "http",
      replica,
      commit: "abc1234",
      v: 1,
      utilization: 0.25,
      waiting: 3,
      realtime: { local_connections: 5 },
    });
    // uuid v7: the version nibble is 7.
    expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
  });

  it("gets one row per window from the runtime collector, through the sampler", async () => {
    const replica = `e2e-${randomUUID()}`;
    const warnings: unknown[] = [];

    const sampler = createOpsSampler({
      enabled: true,
      identity: { role: "all", replica, commit: null },
      sections: createSampleSections(),
      random: () => 0,
      log: { warn: (fields) => warnings.push(fields) },
    });
    const metrics = createRuntimeMetrics({
      windowMs: 300,
      canaryIntervalMs: 50,
    });
    const stop = startRuntimeMetrics(
      { info: () => undefined },
      metrics,
      async () => ({ limit: 10, open: 1, busy: 0, idle: 1, waiting: 0 }),
      undefined,
      { onWindow: (window) => sampler.record(window) },
    );

    try {
      await vi.waitFor(
        async () => expect((await rowsOf(replica)).length).toBeGreaterThan(1),
        { timeout: 10_000, interval: 100 },
      );
    } finally {
      stop();
      sampler.stop();
    }

    const rows = await rowsOf(replica);

    expect(warnings).toEqual([]);
    expect(rows.every((row) => row.role === "all" && row.v === 1)).toBe(true);
    expect(rows.every((row) => row.waiting === 0)).toBe(true);
    expect(rows[1].ts.getTime()).toBeGreaterThan(rows[0].ts.getTime());
  });
});
