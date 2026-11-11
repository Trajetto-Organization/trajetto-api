import { afterAll, beforeAll, describe, expect, it } from "vitest";

import Redis from "ioredis";
import { randomUUID } from "node:crypto";

import { redisClientOptions } from "@/config/redis-client-options";
import {
  MINUTE_MS,
  createRedisGeocodingGate,
  pauseReasonOf,
} from "@/shared/delivery/geocoding/geocoding-gate";
import { createRedisAddressSearchStore } from "@/shared/services/address-search/address-search-limits";

import { geocodingTestKeys } from "./support/geocoding-test-keys";

/**
 * The provider's gate and the address search's cache as Redis runs them
 * (plan pin-search). The unit tests (geocoding-gate.test.ts,
 * search-address-usecase.test.ts) run doubles of these scripts; here the
 * gate and the store themselves run, scripts and arguments included, so a
 * Lua that does not do what the double does fails.
 *
 * - TAKE_SLOT: one call a second, a ceiling over any 60 s (the sliding
 *   log), both or neither, and a refused try that touches nothing;
 * - EXTEND_PAUSE: a longer pause is never cut short;
 * - the cache's value is sealed in Redis and opens only as it was written.
 *
 * On keys of this run's own (support/geocoding-test-keys.ts), never
 * production's: the search's E2E runs the gate too, and Redis can serve
 * another run at the same time.
 */
let redis: Redis;

const GEOCODING = geocodingTestKeys();
const keys = GEOCODING.keys;

/** Far from today, so no window of the app's could ever be these. */
const T0 = Date.UTC(2099, 2, 14, 12, 0, 0);

/** The gate at `now`, with this ceiling in any 60 s. */
function gateAt(now: number, perMinute: number, perSecond = 1) {
  return createRedisGeocodingGate(redis, {
    keys,
    perMinute,
    perSecond,
    clock: () => now,
  });
}

const take = (now: number, perMinute: number) =>
  gateAt(now, perMinute).takeSlot();

beforeAll(async () => {
  redis = new Redis(
    process.env.REDIS_URL!,
    redisClientOptions("geocoding-budget"),
  );
});

afterAll(async () => {
  await GEOCODING.clear(redis);
  redis?.disconnect();
});

describe("TAKE_SLOT in Redis", () => {
  it("grants one call a second, and a refused try touches neither window", async () => {
    expect(await take(T0, 50)).toBe(true);
    expect(await take(T0 + 500, 50)).toBe(false);

    expect(await redis.get(keys.second(T0 / 1000))).toBe("1");
    expect(await redis.zcard(keys.minute)).toBe(1);
    expect(await redis.ttl(keys.second(T0 / 1000))).toBeGreaterThan(0);
  });

  it("holds the ceiling over any 60 s, across the clock's minute", async () => {
    await redis.del(keys.minute);

    // Three a minute, the last two seconds of one clock minute and the
    // first of the next: within 60 s, so the fourth waits.
    const start = T0 + 58_000;

    expect(await take(start, 3)).toBe(true);
    expect(await take(start + 1_000, 3)).toBe(true);
    expect(await take(start + 2_000, 3)).toBe(true);
    expect(await take(start + 3_000, 3)).toBe(false);
    // Refused: not in the log, not in the second.
    expect(await redis.zcard(keys.minute)).toBe(3);
    expect(await redis.get(keys.second((start + 3_000) / 1000))).toBeNull();

    // 59 s after the first call it is still within the 60 s.
    expect(await take(start + 59_000, 3)).toBe(false);
    // 60 s after it, it leaves the log and the slot opens.
    expect(await take(start + 60_000, 3)).toBe(true);
    expect(await redis.zcard(keys.minute)).toBe(3);

    // The log expires a minute after its last call.
    const ttl = await redis.pttl(keys.minute);

    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(MINUTE_MS);
  });

  it("counts two calls of the same millisecond as two", async () => {
    await redis.del(keys.minute);

    // Two a second, so the second call of the instant is granted too.
    const gate = gateAt(T0 + 300_000, 50, 2);

    expect(await gate.takeSlot()).toBe(true);
    expect(await gate.takeSlot()).toBe(true);

    expect(await redis.zcard(keys.minute)).toBe(2);
  });
});

describe("EXTEND_PAUSE in Redis", () => {
  it("writes a longer pause and never cuts one short", async () => {
    const now = new Date();
    const after = (ms: number) => new Date(now.getTime() + ms);
    const gate = createRedisGeocodingGate(redis, { keys });

    expect(await gate.paused(now)).toBe(false);

    await gate.pause(after(600_000), now, "QUOTA");
    await gate.pause(after(60_000), now, "BURST");

    expect(pauseReasonOf(await redis.get(keys.pause))).toBe("QUOTA");
    expect(await gate.paused(now)).toBe(true);

    await gate.pause(after(900_000), now, "REFUSED");

    expect(pauseReasonOf(await redis.get(keys.pause))).toBe("REFUSED");
    expect(await redis.pttl(keys.pause)).toBeGreaterThan(600_000);
  });
});

describe("the address search's cache in Redis", () => {
  const business = randomUUID();
  const digest = "f".repeat(64);
  const answer = {
    results: [
      {
        id: "p1",
        title: "Rua Epitácio Pessoa, 120",
        subtitle: "Centro, Petrópolis - RJ, 25610-000",
        latitude: -22.5084,
        longitude: -43.1735,
        precision: "ADDRESS" as const,
        city: "Petrópolis",
        uf: "RJ" as const,
        bbox: null,
        inScope: true,
      },
    ],
    weak: false,
  };

  it("keeps the suggestions sealed, and opens only what it wrote", async () => {
    const store = createRedisAddressSearchStore(redis, undefined, keys);
    const key = keys.searchCache(business, digest);

    await store.remember(business, digest, answer, 60);

    const stored = (await redis.get(key)) ?? "";

    expect(stored).toMatch(/^enc:v1:/);
    expect(stored).not.toMatch(/epit|pessoa|petr|25610/i);
    expect(await redis.ttl(key)).toBeGreaterThan(0);

    expect(await store.cached(business, digest)).toEqual(answer);

    // A value in clear, or one tampered with, is a miss.
    await redis.set(key, JSON.stringify(answer));
    expect(await store.cached(business, digest)).toBeNull();

    await redis.set(key, `${stored.slice(0, -4)}AAAA`);
    expect(await store.cached(business, digest)).toBeNull();
  });
});
