import { describe, expect, it } from "vitest";

import { createRedisGeocodingBudget } from "@/shared/delivery/geocoding/geocoding-budget";
import { GEOCODING_KEYS } from "@/shared/delivery/geocoding/geocoding-keys";

/**
 * The geocoding job's daily budget (plan of 02/11/2026, E1): one counter
 * per UTC day in Redis, shared by every replica, that fails CLOSED — a
 * lookup put off costs a minute, a lookup over the quota costs money.
 */
const NOW = new Date("2026-11-03T15:00:00.000Z");

function fakeRedis(failing = false) {
  const counts = new Map<string, number>();

  return {
    counts,
    redis: {
      async get(key: string) {
        if (failing) throw new Error("ECONNREFUSED");

        return counts.has(key) ? String(counts.get(key)) : null;
      },
      async eval(_script: string, _keys: number, key: string) {
        if (failing) throw new Error("ECONNREFUSED");

        counts.set(key, (counts.get(key) ?? 0) + 1);

        return counts.get(key);
      },
    },
  };
}

describe("the geocoding budget", () => {
  it("counts the day's lookups against the limit", async () => {
    const { redis, counts } = fakeRedis();
    const budget = createRedisGeocodingBudget(redis as never, 3);

    expect(await budget.remaining(NOW)).toBe(3);

    await budget.spend(NOW);
    await budget.spend(NOW);

    expect(await budget.remaining(NOW)).toBe(1);
    expect(counts.get(GEOCODING_KEYS.budget(NOW))).toBe(2);
    expect(GEOCODING_KEYS.budget(NOW)).toBe("geocoding:deliveries:2026-11-03");
  });

  it("starts again on the next UTC day", async () => {
    const { redis } = fakeRedis();
    const budget = createRedisGeocodingBudget(redis as never, 1);

    await budget.spend(NOW);

    expect(await budget.remaining(NOW)).toBe(0);
    expect(await budget.remaining(new Date("2026-11-04T00:00:01.000Z"))).toBe(
      1,
    );
  });

  it("allows nothing when Redis does not answer, or with a zero limit", async () => {
    const errors: unknown[] = [];
    const closed = createRedisGeocodingBudget(
      fakeRedis(true).redis as never,
      100,
      (err) => errors.push(err),
    );

    expect(await closed.remaining(NOW)).toBe(0);
    expect(errors).toHaveLength(1);

    expect(
      await createRedisGeocodingBudget(fakeRedis().redis as never, 0).remaining(
        NOW,
      ),
    ).toBe(0);
  });
});
