import { describe, expect, it } from "vitest";

import { GEOCODING_SCOPES } from "@/shared/delivery/geocoding/geocoding-budget";
import { pauseValue } from "@/shared/delivery/geocoding/geocoding-gate";
import { createRedisGeocodingHold } from "@/shared/delivery/geocoding/geocoding-hold";
import { GEOCODING_KEYS } from "@/shared/delivery/geocoding/geocoding-keys";

/**
 * Whether the address lookups are held for more than a moment (review of
 * 09/11/2026): a staging with a wrong key showed "Localizando endereço…"
 * for good. Held while the provider refuses the requests, its daily quota
 * is spent or today's budget is gone — never for a burst's minute. The
 * day is the Postgres row since F2-32; the Redis key, a mirror for the
 * previous image, only adds to it.
 */
const NOW = new Date("2026-11-09T15:00:00.000Z");
const LATER = new Date(NOW.getTime() + 15 * 60_000);

/** The day's row of the job's scope (provider_quota_day), as read. */
function dayOf(used: number | "failing" = 0) {
  const asked: Array<{ day: string; scopes: readonly string[] }> = [];

  return {
    asked,
    quota: {
      async used(_provider: string, day: string, scopes: readonly string[]) {
        asked.push({ day, scopes });

        if (used === "failing") throw new Error("connection terminated");

        return { [GEOCODING_SCOPES.job]: used };
      },
    },
  };
}

const hold = (
  redis: ReturnType<typeof redisWith>["redis"],
  limit: number,
  quota = dayOf().quota,
) =>
  createRedisGeocodingHold(redis as never, () => limit, GEOCODING_KEYS, quota);

function redisWith(values: Record<string, string>, failing = false) {
  const asked: string[][] = [];

  return {
    asked,
    redis: {
      async mget(...keys: string[]) {
        asked.push(keys);

        if (failing) throw new Error("ECONNREFUSED");

        return keys.map((key) => values[key] ?? null);
      },
    },
  };
}

describe("the geocoding hold", () => {
  it("holds while the provider refuses the requests or its day's quota is spent", async () => {
    for (const reason of ["REFUSED", "QUOTA"] as const) {
      const { redis } = redisWith({
        [GEOCODING_KEYS.pause]: pauseValue(reason, LATER),
      });

      expect(await hold(redis, 2_000).held(NOW)).toBe(true);
    }
  });

  it("does not hold for a burst's minute: the next run asks again", async () => {
    const { redis } = redisWith({
      [GEOCODING_KEYS.pause]: pauseValue("BURST", LATER),
    });

    expect(await hold(redis, 2_000).held(NOW)).toBe(false);
  });

  it("holds once today's budget is spent, reading today's key and the pause in one call", async () => {
    const { redis, asked } = redisWith({
      [GEOCODING_KEYS.budget(NOW)]: "2000",
    });

    expect(await hold(redis, 2_000).held(NOW)).toBe(true);
    expect(await hold(redis, 2_001).held(NOW)).toBe(false);
    expect(asked[0]).toEqual([
      GEOCODING_KEYS.pause,
      GEOCODING_KEYS.budget(NOW),
    ]);
  });

  // Review of plano-escala F2-32: the day moved to Postgres, and the hold
  // still read only the Redis key, now a mirror written on each take. An
  // eviction once the day was spent left the key at 0 (a refused take
  // writes no mirror), and the route page said "Localizando endereço…"
  // for stops nothing would look up until midnight; F2-36 drops the key.
  it("holds once today's row is spent, the Redis key evicted or gone", async () => {
    const { redis } = redisWith({});
    const day = dayOf(2_000);

    expect(await hold(redis, 2_000, day.quota).held(NOW)).toBe(true);
    expect(day.asked).toEqual([
      { day: "2026-11-09", scopes: [GEOCODING_SCOPES.job] },
    ]);
    expect(await hold(redis, 2_001, dayOf(2_000).quota).held(NOW)).toBe(false);
  });

  it("reads the row even when Redis does not answer, and holds nothing when neither does", async () => {
    const { redis } = redisWith({}, true);

    expect(await hold(redis, 2_000, dayOf(2_000).quota).held(NOW)).toBe(true);
    expect(await hold(redis, 2_000, dayOf(1_999).quota).held(NOW)).toBe(false);
    expect(await hold(redis, 2_000, dayOf("failing").quota).held(NOW)).toBe(
      false,
    );
  });

  it("does not read the row when the key already says the day is spent", async () => {
    const { redis } = redisWith({ [GEOCODING_KEYS.budget(NOW)]: "2000" });
    const day = dayOf("failing");

    expect(await hold(redis, 2_000, day.quota).held(NOW)).toBe(true);
    expect(day.asked).toEqual([]);
  });
});
