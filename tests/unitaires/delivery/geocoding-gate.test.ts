import { describe, expect, it } from "vitest";

import {
  EXTEND_PAUSE,
  GEOCODING_CALLS_PER_SECOND,
  PAUSE_KEY,
  createRedisGeocodingGate,
  pauseReasonOf,
  pauseValue,
  slotKey,
} from "@/shared/delivery/geocoding/geocoding-gate";

/**
 * When the geocoder may call the provider (owner's report of 09/11/2026):
 * the pause every replica honours after a refusal or a 429, and the
 * per-second slot the minute's job and the lookups after a commit share.
 * Both in Redis, both failing CLOSED — a lookup put off costs a minute, one
 * the provider refuses costs an attempt or the quota.
 */
const NOW = new Date("2026-11-09T15:00:00.000Z");

function fakeRedis(failing = false) {
  const values = new Map<string, { value: string; ttlMs: number | null }>();
  const counts = new Map<string, number>();

  return {
    values,
    counts,
    redis: {
      async get(key: string) {
        if (failing) throw new Error("ECONNREFUSED");

        return values.get(key)?.value ?? null;
      },
      async eval(
        script: string,
        _keys: number,
        key: string,
        ...args: unknown[]
      ) {
        if (failing) throw new Error("ECONNREFUSED");

        if (script === EXTEND_PAUSE) {
          const [value, ms] = args as [string, number];
          const left = values.get(key)?.ttlMs ?? -2;

          if (left < Number(ms)) values.set(key, { value, ttlMs: Number(ms) });

          return 1;
        }

        counts.set(key, (counts.get(key) ?? 0) + 1);

        return counts.get(key);
      },
    },
  };
}

describe("the geocoding pause", () => {
  it("holds every replica until it ends, and never shortens a longer one", async () => {
    const { redis, values } = fakeRedis();
    const gate = createRedisGeocodingGate(redis as never);

    expect(await gate.paused(NOW)).toBe(false);

    await gate.pause(new Date("2026-11-10T00:00:00.000Z"), NOW, "QUOTA");

    expect(await gate.paused(NOW)).toBe(true);
    expect(values.get(PAUSE_KEY)).toEqual({
      value: "QUOTA 2026-11-10T00:00:00.000Z",
      ttlMs: 9 * 60 * 60 * 1000,
    });

    // A burst's minute after the day's quota: the day's pause stays,
    // with its reason.
    await gate.pause(new Date(NOW.getTime() + 60_000), NOW, "BURST");

    expect(values.get(PAUSE_KEY)).toEqual({
      value: "QUOTA 2026-11-10T00:00:00.000Z",
      ttlMs: 9 * 60 * 60 * 1000,
    });
  });

  it("keeps the reason beside the deadline, for the route read", () => {
    const until = new Date(NOW.getTime() + 15 * 60_000);

    expect(pauseValue("REFUSED", until)).toBe(
      "REFUSED 2026-11-09T15:15:00.000Z",
    );
    expect(pauseReasonOf(pauseValue("REFUSED", until))).toBe("REFUSED");
    expect(pauseReasonOf(pauseValue("QUOTA", until))).toBe("QUOTA");
    expect(pauseReasonOf(pauseValue("BURST", until))).toBe("BURST");
    expect(pauseReasonOf(null)).toBeNull();
    expect(pauseReasonOf("2026-11-09T15:15:00.000Z")).toBeNull();
  });

  it("ignores a deadline already past", async () => {
    const { redis, values } = fakeRedis();
    const gate = createRedisGeocodingGate(redis as never);

    await gate.pause(new Date(NOW.getTime() - 1), NOW, "BURST");

    expect(values.size).toBe(0);
  });

  it("reads as paused when Redis does not answer", async () => {
    const errors: unknown[] = [];
    const gate = createRedisGeocodingGate(fakeRedis(true).redis as never, {
      onError: (err) => errors.push(err),
    });

    expect(await gate.paused(NOW)).toBe(true);
    await gate.pause(new Date(NOW.getTime() + 60_000), NOW, "BURST");
    expect(errors).toHaveLength(2);
  });
});

describe("the per-second slot", () => {
  it("gives one call a second across every caller, the other left to the proof's reverse lookup", async () => {
    const { redis } = fakeRedis();
    let clock = NOW.getTime();

    const job = createRedisGeocodingGate(redis as never, {
      clock: () => clock,
    });
    const soon = createRedisGeocodingGate(redis as never, {
      clock: () => clock,
    });

    expect(GEOCODING_CALLS_PER_SECOND).toBe(1);
    expect(await job.takeSlot()).toBe(true);
    expect(await soon.takeSlot()).toBe(false);
    expect(await job.takeSlot()).toBe(false);

    clock += 1_000;

    expect(await soon.takeSlot()).toBe(true);
    expect(slotKey(Math.floor(clock / 1000))).toBe(
      `geocoding:deliveries:rate:${Math.floor(clock / 1000)}`,
    );
  });

  it("gives no slot when Redis does not answer", async () => {
    const gate = createRedisGeocodingGate(fakeRedis(true).redis as never);

    expect(await gate.takeSlot()).toBe(false);
  });
});
