import type { Redis } from "ioredis";

import { countInFixedWindow } from "@/shared/services/fixed-window-counter";

import { GEOCODING_KEYS, type GeocodingKeys } from "./geocoding-keys";

/**
 * How many lookups the geocoding job may still make today, across every
 * replica (plan of 02/11/2026, E1; decision D15: the provider has a quota
 * and a price). A fixed window per UTC day in Redis — the house's counter
 * (shared/services/fixed-window-counter.ts) — shared by all replicas.
 *
 * It fails CLOSED, unlike the request limiters: a limiter that fails open
 * costs a limit and spares a customer's call, but here failing open could
 * only spend money, while failing closed only delays a coordinate to the
 * next minute.
 */
interface GeocodingBudget {
  /** Lookups left today; 0 when unknown. */
  remaining(now: Date): Promise<number>;
  /** One lookup made. */
  spend(now: Date): Promise<void>;
}

/** A day and two hours, so the key of a day outlives the day itself. */
const WINDOW_SECONDS = 26 * 60 * 60;

function createRedisGeocodingBudget(
  redis: Pick<Redis, "eval" | "get">,
  dailyLimit: number,
  onError: (err: unknown) => void = () => undefined,
  keys: GeocodingKeys = GEOCODING_KEYS,
): GeocodingBudget {
  return {
    async remaining(now) {
      if (dailyLimit <= 0) return 0;

      try {
        const used = Number((await redis.get(keys.budget(now))) ?? 0);

        return Math.max(0, dailyLimit - (Number.isFinite(used) ? used : 0));
      } catch (err) {
        onError(err);

        return 0;
      }
    },

    async spend(now) {
      try {
        await countInFixedWindow(redis, keys.budget(now), WINDOW_SECONDS);
      } catch (err) {
        onError(err);
      }
    },
  };
}

export { createRedisGeocodingBudget };
export type { GeocodingBudget };
