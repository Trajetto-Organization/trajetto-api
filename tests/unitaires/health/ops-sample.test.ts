import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OPS_SAMPLE_MAX_JITTER_MS,
  OPS_SAMPLE_VERSION,
  buildOpsSampleRow,
  createOpsSampler,
  createSampleSections,
  opsSampleRole,
  type OpsSampleRow,
  type OpsSampleWindow,
} from "@/shared/health/ops-sample";
import {
  createRuntimeMetrics,
  startRuntimeMetrics,
} from "@/shared/health/runtime-metrics";

/**
 * The per-minute series of every process (plano-escala F1-08).
 *
 * The ADR 0001 triggers ("pool waiting > 0 for a minute", "ELU > 0.7 at the
 * peak") were written against numbers nobody kept: /health/metrics answers
 * for one replica, now, and the minute log line lives as long as the log
 * rotation. Each process now writes one ops_sample row a minute, so 14 days
 * of series exist before any decision. What this pins:
 *
 *  - the row is a versioned document (v=1) of infra numbers, with no key
 *    that could carry a person or a tenant;
 *  - the write waits a random 0–15 s after the minute, so replicas started
 *    together do not hit the database in the same second;
 *  - a failed or hung write never throws, never stops the next minute, and
 *    never piles up;
 *  - switched off, nothing is written, and the per-window sections still
 *    rotate.
 */
afterEach(() => {
  vi.useRealTimers();
});

function window(at = new Date("2026-11-15T12:01:00.000Z")): OpsSampleWindow {
  return {
    endedAt: at,
    runtime: {
      replica: "api-1",
      window_seconds: 60,
      event_loop: {
        lag_p50_ms: 10.2,
        lag_p99_ms: 22.1,
        lag_max_ms: 40,
        utilization: 0.12,
      },
      threadpool: { size: 8, canary_last_ms: 0.4, canary_max_ms: 1.2 },
      memory: { rss_mb: 210.5, heap_used_mb: 120.1 },
      prisma_pool: { limit: 10, open: 3, busy: 1, idle: 2, waiting: 0 },
    },
    providers: [
      {
        channel: "EMAIL",
        calls: 3,
        errors: 1,
        error_rate: 0.333,
        latency_p50_ms: 120,
        latency_p95_ms: 300,
        latency_max_ms: 300,
        total_calls: 10,
        total_errors: 1,
        last_error_at: "2026-11-15T12:00:30.000Z",
        last_error_kind: "http_500",
      },
    ],
  };
}

const IDENTITY = { role: "all" as const, replica: "api-1", commit: "abc1234" };

/** Every key of a document, at every depth. */
function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (value === null || typeof value !== "object") return [];

  return Object.entries(value).flatMap(([key, inner]) => [
    key,
    ...keysOf(inner),
  ]);
}

const PERSON_OR_TENANT =
  /business|tenant|user|driver|customer|person|email|phone|cpf|cnpj|\bip\b|address|token|session/i;

describe("the ops_sample row", () => {
  it("is a versioned document with the process in the columns", () => {
    const row = buildOpsSampleRow(window(), IDENTITY, {
      realtime: { local_connections: 4 },
    });

    expect(OPS_SAMPLE_VERSION).toBe(1);
    expect(row).toEqual({
      ts: new Date("2026-11-15T12:01:00.000Z"),
      role: "all",
      replica: "api-1",
      commit: "abc1234",
      metrics: {
        v: 1,
        window_seconds: 60,
        event_loop: window().runtime.event_loop,
        threadpool: window().runtime.threadpool,
        memory: window().runtime.memory,
        prisma_pool: window().runtime.prisma_pool,
        providers: window().providers,
        realtime: { local_connections: 4 },
      },
    });
  });

  it("carries no key that could name a person or a tenant", () => {
    const row = buildOpsSampleRow(window(), IDENTITY, {
      realtime: { local_connections: 4, adapter_status: "ready" },
      bcrypt: { active: 0, queued: 0 },
    });

    expect(
      keysOf(row.metrics).filter((key) => PERSON_OR_TENANT.test(key)),
    ).toEqual([]);
  });

  it("refuses a section that would overwrite the row's own fields", () => {
    const sections = createSampleSections();

    expect(() => sections.register("v", () => 2)).toThrow();
    expect(() => sections.register("event_loop", () => 0)).toThrow();
    expect(() => sections.register("Has Spaces", () => 0)).toThrow();
  });

  it("reads each section once, and a section that throws is null", () => {
    const sections = createSampleSections();
    const http = vi.fn(() => ({ requests: 3 }));

    sections.register("http", http);
    sections.register("broken", () => {
      throw new Error("boom");
    });

    expect(sections.read()).toEqual({ http: { requests: 3 }, broken: null });
    expect(http).toHaveBeenCalledTimes(1);
  });

  it("names the role after WORKERS_ENABLED until PROCESS_ROLE exists", () => {
    expect(opsSampleRole(true)).toBe("all");
    expect(opsSampleRole(false)).toBe("http");
  });
});

describe("the sampler", () => {
  function sampler(options: {
    enabled?: boolean;
    write?: (row: OpsSampleRow) => Promise<void>;
    random?: () => number;
  }) {
    const warnings: unknown[] = [];
    const sections = createSampleSections();
    const rotations = vi.fn(() => ({ requests: 1 }));
    sections.register("http", rotations);

    const instance = createOpsSampler({
      enabled: options.enabled ?? true,
      identity: IDENTITY,
      sections,
      write: options.write ?? (async () => undefined),
      random: options.random ?? (() => 0.5),
      log: { warn: (fields: unknown) => warnings.push(fields) },
    });

    return { instance, warnings, rotations };
  }

  it("writes the minute 0–15 s after it ends, never before its jitter", async () => {
    vi.useFakeTimers();

    const write = vi.fn(async () => undefined);
    const { instance } = sampler({ write, random: () => 0.5 });

    instance.record(window());

    await vi.advanceTimersByTimeAsync(OPS_SAMPLE_MAX_JITTER_MS / 2 - 1);
    expect(write).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect((write.mock.calls[0] as unknown[])[0]).toMatchObject({
      ts: window().endedAt,
      metrics: { v: 1, http: { requests: 1 } },
    });

    instance.stop();
  });

  it("never waits more than 15 s", async () => {
    vi.useFakeTimers();

    const write = vi.fn(async () => undefined);
    const { instance } = sampler({ write, random: () => 0.999999 });

    instance.record(window());
    await vi.advanceTimersByTimeAsync(OPS_SAMPLE_MAX_JITTER_MS);

    expect(write).toHaveBeenCalledTimes(1);
    instance.stop();
  });

  it("keeps going, without throwing, when the database refuses the write", async () => {
    vi.useFakeTimers();

    const write = vi
      .fn<[OpsSampleRow], Promise<void>>()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValue(undefined);
    const { instance, warnings } = sampler({ write, random: () => 0 });

    expect(() => instance.record(window())).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);

    expect(warnings).toHaveLength(1);

    instance.record(window(new Date("2026-11-15T12:02:00.000Z")));
    await vi.advanceTimersByTimeAsync(0);

    expect(write).toHaveBeenCalledTimes(2);
    instance.stop();
  });

  it("skips a minute while the previous write still hangs, instead of piling up", async () => {
    vi.useFakeTimers();

    const write = vi.fn(() => new Promise<void>(() => undefined));
    const { instance, warnings } = sampler({ write, random: () => 0 });

    instance.record(window());
    await vi.advanceTimersByTimeAsync(0);
    instance.record(window(new Date("2026-11-15T12:02:00.000Z")));
    await vi.advanceTimersByTimeAsync(0);

    expect(write).toHaveBeenCalledTimes(1);
    expect(warnings).toHaveLength(1);
    instance.stop();
  });

  it("writes nothing when switched off, and the sections still rotate", async () => {
    vi.useFakeTimers();

    const write = vi.fn(async () => undefined);
    const { instance, rotations } = sampler({ enabled: false, write });

    instance.record(window());
    await vi.advanceTimersByTimeAsync(OPS_SAMPLE_MAX_JITTER_MS);

    expect(write).not.toHaveBeenCalled();
    expect(rotations).toHaveBeenCalledTimes(1);
    instance.stop();
  });

  it("drops a pending write on stop: a stopping process keeps nothing alive", async () => {
    vi.useFakeTimers();

    const write = vi.fn(async () => undefined);
    const { instance } = sampler({ write, random: () => 0.5 });

    instance.record(window());
    instance.stop();
    await vi.advanceTimersByTimeAsync(OPS_SAMPLE_MAX_JITTER_MS);

    expect(write).not.toHaveBeenCalled();
  });
});

describe("startRuntimeMetrics and the sample", () => {
  it("hands every window, with the pool, to the sample", async () => {
    vi.useFakeTimers();

    const windows: OpsSampleWindow[] = [];
    const metrics = createRuntimeMetrics({
      windowMs: 1_000,
      canaryIntervalMs: 60_000,
    });

    const stop = startRuntimeMetrics(
      { info: () => undefined },
      metrics,
      async () => ({ limit: 10, waiting: 0 }),
      undefined,
      { onWindow: (each) => windows.push(each) },
    );

    try {
      await vi.advanceTimersByTimeAsync(2_000);
    } finally {
      stop();
    }

    expect(windows).toHaveLength(2);
    expect(windows[0].runtime.prisma_pool).toEqual({ limit: 10, waiting: 0 });
    expect(windows[0].endedAt).toBeInstanceOf(Date);
  });

  it("still logs the line when the sample throws", async () => {
    vi.useFakeTimers();

    const lines: string[] = [];
    const metrics = createRuntimeMetrics({
      windowMs: 1_000,
      canaryIntervalMs: 60_000,
    });

    const stop = startRuntimeMetrics(
      { info: (_fields, message) => lines.push(message) },
      metrics,
      undefined,
      undefined,
      {
        onWindow: () => {
          throw new Error("sample bug");
        },
      },
    );

    try {
      await vi.advanceTimersByTimeAsync(2_000);
    } finally {
      stop();
    }

    expect(lines).toEqual(["runtime metrics", "runtime metrics"]);
  });
});
