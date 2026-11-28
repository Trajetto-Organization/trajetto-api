import type { Redis } from "ioredis";

import { env } from "@/env";
import { logger } from "@/shared/logging/logger";
import {
  ProviderQuotaRepository,
  quotaDay,
  type IProviderQuotaRepository,
} from "@/shared/services/provider-quota/provider-quota-repository";

import {
  GEOCODER_PROVIDER,
  GEOCODING_SCOPES,
  countOf,
} from "./geocoding-budget";
import { pauseReasonOf } from "./geocoding-gate";
import { GEOCODING_KEYS, type GeocodingKeys } from "./geocoding-keys";

const log = logger.child({ component: "geocoding-hold" });

/**
 * Whether the address lookups are held for more than a moment — for the
 * route read only (address-lookup-state.ts), never for the geocoder, whose
 * gate and budget decide for themselves. While the provider refuses the
 * requests (a wrong key or URL: a pause renewed every 15 min), its daily
 * quota is spent (a pause until midnight UTC) or today's budget is gone,
 * no stop is being looked up, and the page must not say "Localizando
 * endereço…" (review of 09/11/2026: a staging with a wrong key showed the
 * spinner for good, and the dispatcher waited instead of pinning).
 *
 * A burst's minute is not a hold: the next minute's run asks again.
 *
 * One MGET on the request path's fail-fast connection (the rate-limit one,
 * wired in http.ts) — the pause, and the previous image's copy of the day
 * — and the day's row in Postgres (provider_quota_day, the job's scope),
 * only when a stop of the route could read as SEARCHING. The row is the
 * day since F2-32: the key is a mirror written on each take, which an
 * eviction once the day is spent leaves at 0 (a refused take writes no
 * mirror), and F2-36 drops it (review of F2-32). The row is not read when
 * the key already says the day is spent. When neither answers, nothing is
 * held: the time bound of address-lookup-state.ts still ends the spinner.
 */
interface GeocodingHold {
  held(now: Date): Promise<boolean>;
}

function createRedisGeocodingHold(
  redis: Pick<Redis, "mget">,
  dailyLimit: () => number = () => env.DELIVERY_GEOCODING_DAILY_BUDGET,
  keys: GeocodingKeys = GEOCODING_KEYS,
  quota: Pick<IProviderQuotaRepository, "used"> = new ProviderQuotaRepository(),
): GeocodingHold {
  /** The job's row of the day; 0 when unreadable. */
  const rowOf = async (now: Date): Promise<number> => {
    try {
      const counts = await quota.used(GEOCODER_PROVIDER, quotaDay(now), [
        GEOCODING_SCOPES.job,
      ]);

      return counts[GEOCODING_SCOPES.job] ?? 0;
    } catch (err) {
      log.debug({ err }, "geocoding hold: the day's row unreadable");

      return 0;
    }
  };

  return {
    async held(now) {
      let pause: string | null = null;
      let mirrored: string | null = null;

      try {
        [pause, mirrored] = await redis.mget(keys.pause, keys.budget(now));
      } catch (err) {
        // Debug, not warn: during an outage every route read would write a
        // line, and the connection log already says Redis is gone.
        log.debug({ err }, "geocoding hold unreadable");
      }

      const reason = pauseReasonOf(pause);

      if (reason === "REFUSED" || reason === "QUOTA") return true;

      const limit = dailyLimit();

      if (limit <= 0) return false;

      if (countOf(mirrored) >= limit) return true;

      return (await rowOf(now)) >= limit;
    },
  };
}

/** For paths with no Redis (unit tests, scripts): never held. */
const noGeocodingHold: GeocodingHold = { held: async () => false };

// Wired in http.ts with the rate-limit Redis connection.
let hold: GeocodingHold = noGeocodingHold;

function configureGeocodingHold(next: GeocodingHold): void {
  hold = next;
}

function geocodingHeld(now: Date): Promise<boolean> {
  return hold.held(now);
}

export {
  configureGeocodingHold,
  createRedisGeocodingHold,
  geocodingHeld,
  noGeocodingHold,
};
export type { GeocodingHold };
