import { describe, expect, it } from "vitest";

import { pauseValue } from "@/shared/delivery/geocoding/geocoding-gate";
import { createRedisGeocodingHold } from "@/shared/delivery/geocoding/geocoding-hold";
import { GEOCODING_KEYS } from "@/shared/delivery/geocoding/geocoding-keys";

/**
 * Whether the address lookups are held for more than a moment (review of
 * 09/11/2026): a staging with a wrong key showed "Localizando endereço…"
 * for good. Held while the provider refuses the requests, its daily quota
 * is spent or today's budget is gone — never for a burst's minute, and
 * never on a Redis that does not answer (the time bound ends the spinner).
 */
const NOW = new Date("2026-11-09T15:00:00.000Z");
const LATER = new Date(NOW.getTime() + 15 * 60_000);

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

      expect(
        await createRedisGeocodingHold(redis as never, () => 2_000).held(NOW),
      ).toBe(true);
    }
  });

  it("does not hold for a burst's minute: the next run asks again", async () => {
    const { redis } = redisWith({
      [GEOCODING_KEYS.pause]: pauseValue("BURST", LATER),
    });

    expect(
      await createRedisGeocodingHold(redis as never, () => 2_000).held(NOW),
    ).toBe(false);
  });

  it("holds once today's budget is spent, reading today's key and the pause in one call", async () => {
    const { redis, asked } = redisWith({
      [GEOCODING_KEYS.budget(NOW)]: "2000",
    });

    expect(
      await createRedisGeocodingHold(redis as never, () => 2_000).held(NOW),
    ).toBe(true);
    expect(
      await createRedisGeocodingHold(redis as never, () => 2_001).held(NOW),
    ).toBe(false);
    expect(asked[0]).toEqual([
      GEOCODING_KEYS.pause,
      GEOCODING_KEYS.budget(NOW),
    ]);
  });

  it("holds nothing when Redis does not answer", async () => {
    const { redis } = redisWith({}, true);

    expect(
      await createRedisGeocodingHold(redis as never, () => 2_000).held(NOW),
    ).toBe(false);
  });
});
