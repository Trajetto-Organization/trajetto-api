import type { Redis } from "ioredis";

import { env } from "@/env";
import { logger } from "@/shared/logging/logger";

import { budgetKey } from "./geocoding-budget";
import { PAUSE_KEY, pauseReasonOf } from "./geocoding-gate";

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
 * wired in http.ts), and only when a stop of the route could read as
 * SEARCHING. When Redis does not answer, nothing is held: the time bound
 * of address-lookup-state.ts still ends the spinner.
 */
interface GeocodingHold {
  held(now: Date): Promise<boolean>;
}

function createRedisGeocodingHold(
  redis: Pick<Redis, "mget">,
  dailyLimit: () => number = () => env.DELIVERY_GEOCODING_DAILY_BUDGET,
): GeocodingHold {
  return {
    async held(now) {
      try {
        const [pause, used] = await redis.mget(PAUSE_KEY, budgetKey(now));
        const reason = pauseReasonOf(pause);

        if (reason === "REFUSED" || reason === "QUOTA") return true;

        const limit = dailyLimit();
        const spent = Number(used ?? 0);

        return limit > 0 && Number.isFinite(spent) && spent >= limit;
      } catch (err) {
        // Debug, not warn: during an outage every route read would write a
        // line, and the connection log already says Redis is gone.
        log.debug({ err }, "geocoding hold unreadable");

        return false;
      }
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
