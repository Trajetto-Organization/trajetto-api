import { describe, expect, it } from "vitest";

import { createRuntimeMetrics } from "@/shared/health/runtime-metrics";

/**
 * CPU per request, per replica (plano-escala F4-01).
 *
 * The capacity proof divides the peak's requests by what one replica serves,
 * and "what one replica serves" is CPU per request: the process's CPU in the
 * window over the requests it finished, outside /health (the probes would
 * make every request look cheap). With the workers in the same process the
 * numerator carries their queue work too, and `includes_workers` says so.
 * The number is null without a request — never NaN, never Infinity.
 */
function fakeCpu() {
  let user = 0;
  let system = 0;

  return {
    usage: () => ({ user, system }),
    spend: (userMs: number, systemMs: number) => {
      user += userMs * 1000;
      system += systemMs * 1000;
    },
  };
}

function fakeCounter() {
  let served = 0;

  return {
    read: () => served,
    add: (requests: number) => {
      served += requests;
    },
  };
}

function fakeClock(start = 1_000_000) {
  let now = start;

  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("the CPU of a window", () => {
  it("is the process's CPU over the requests it finished", () => {
    const cpu = fakeCpu();
    const served = fakeCounter();
    const clock = fakeClock();

    const metrics = createRuntimeMetrics({
      cpuUsage: cpu.usage,
      requestsServed: served.read,
      includesWorkers: true,
      now: clock.now,
    });

    cpu.spend(300, 100);
    served.add(8);
    clock.advance(60_000);

    const snapshot = metrics.snapshot();

    expect(snapshot.window_seconds).toBe(60);
    expect(snapshot.cpu).toEqual({
      user_ms: 300,
      system_ms: 100,
      requests: 8,
      ms_per_request: 50,
      includes_workers: true,
    });
  });

  it("is null per request without a request, never NaN or Infinity", () => {
    const cpu = fakeCpu();
    const metrics = createRuntimeMetrics({
      cpuUsage: cpu.usage,
      requestsServed: () => 0,
      includesWorkers: false,
      now: fakeClock().now,
    });

    cpu.spend(50, 0);

    const { cpu: window } = metrics.snapshot();

    expect(window.ms_per_request).toBeNull();
    expect(window.user_ms).toBe(50);
    expect(window.includes_workers).toBe(false);
  });

  it("starts again at every rotation", () => {
    const cpu = fakeCpu();
    const served = fakeCounter();
    const clock = fakeClock();

    const metrics = createRuntimeMetrics({
      cpuUsage: cpu.usage,
      requestsServed: served.read,
      includesWorkers: true,
      now: clock.now,
    });

    cpu.spend(1000, 0);
    served.add(10);
    clock.advance(60_000);

    expect(metrics.rotate().cpu.ms_per_request).toBe(100);

    cpu.spend(40, 20);
    served.add(3);
    clock.advance(30_000);

    const next = metrics.snapshot();

    expect(next.window_seconds).toBe(30);
    expect(next.cpu).toMatchObject({
      user_ms: 40,
      system_ms: 20,
      requests: 3,
      ms_per_request: 20,
    });
  });

  it("never goes negative when a reader steps back", () => {
    let served = 5;

    const metrics = createRuntimeMetrics({
      cpuUsage: () => ({ user: 0, system: 0 }),
      requestsServed: () => served,
      includesWorkers: true,
      now: fakeClock().now,
    });

    served = 2;

    expect(metrics.snapshot().cpu).toMatchObject({
      requests: 0,
      ms_per_request: null,
    });
  });

  it("reads the real process by default", () => {
    const metrics = createRuntimeMetrics();
    const { cpu } = metrics.snapshot();

    expect(Number.isFinite(cpu.user_ms)).toBe(true);
    expect(Number.isFinite(cpu.system_ms)).toBe(true);
    expect(typeof cpu.includes_workers).toBe("boolean");
  });
});
