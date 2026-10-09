import { describe, expect, it } from "vitest";

import {
  STUCK_AFTER_MS,
  WorkerHeartbeatRegistry,
  isStuck,
} from "@/shared/health/worker-heartbeat";

/**
 * A worker stuck on an await that never returns is visible (OBS-10).
 *
 * The workers guard their cycles with an in-memory flag released only in a
 * `finally`. A claim hung on the database kept the flag set, every sweep after
 * that returned at once, and the replica's pipeline stopped for good while
 * /health/liveness kept answering 200. Each cycle now beats: at its start, at
 * each batch and at its end. A worker whose last beat is older than
 * STUCK_AFTER_MS is stuck — mid-cycle (hung) or idle (its sweep stopped
 * firing), and `runningSince` says which.
 */
const T0 = new Date("2026-09-24T04:00:00.000Z").getTime();
const MINUTE_MS = 60_000;

function registryAt(start: number) {
  let now = start;
  const registry = new WorkerHeartbeatRegistry(() => new Date(now));

  return {
    registry,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => new Date(now),
  };
}

describe("worker heartbeats", () => {
  it("a cycle that stops making progress becomes stuck", () => {
    const { registry, advance, now } = registryAt(T0);

    registry.beginCycle("notification-delivery-external");
    advance(11 * MINUTE_MS);

    const [entry] = registry.snapshot();

    expect(entry.worker).toBe("notification-delivery-external");
    expect(entry.runningSince?.getTime()).toBe(T0);
    expect(isStuck(entry, now())).toBe(true);
  });

  it("progress inside a long cycle keeps it alive", () => {
    const { registry, advance, now } = registryAt(T0);

    registry.beginCycle("webhook-dispatch");

    for (let batch = 0; batch < 6; batch += 1) {
      advance(4 * MINUTE_MS);
      registry.progress("webhook-dispatch");
    }

    expect(isStuck(registry.snapshot()[0], now())).toBe(false);
  });

  it("an idle worker whose sweep keeps firing is not stuck", () => {
    const { registry, advance, now } = registryAt(T0);

    for (let sweep = 0; sweep < 40; sweep += 1) {
      registry.beginCycle("ai-analysis");
      registry.endCycle("ai-analysis");
      advance(30_000);
    }

    const [entry] = registry.snapshot();

    expect(entry.runningSince).toBeNull();
    expect(isStuck(entry, now())).toBe(false);
  });

  it("an idle worker whose sweep stopped firing is stuck too", () => {
    const { registry, advance, now } = registryAt(T0);

    registry.beginCycle("notification-outbox");
    registry.endCycle("notification-outbox");
    advance(STUCK_AFTER_MS + MINUTE_MS);

    const [entry] = registry.snapshot();

    expect(entry.runningSince).toBeNull();
    expect(isStuck(entry, now())).toBe(true);
  });

  it("keeps one entry per worker", () => {
    const { registry } = registryAt(T0);

    registry.beginCycle("a");
    registry.endCycle("a");
    registry.beginCycle("b");
    registry.beginCycle("a");

    expect(registry.snapshot().map((entry) => entry.worker).sort()).toEqual([
      "a",
      "b",
    ]);
  });
});
