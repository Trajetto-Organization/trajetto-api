import type { Redis } from "ioredis";

import {
  quotaDay,
  type IProviderQuotaRepository,
} from "@/shared/services/provider-quota/provider-quota-repository";

/**
 * How many lookups the geocoder may still make today, across every replica
 * (plan of 02/11/2026, E1; decision D15: the provider has a quota and a
 * price). Since plano-escala F2-32 the day lives in Postgres
 * (provider_quota_day, the generic take of shared/services/provider-quota),
 * one scope per path of the same account:
 *
 * - "geocoding-job": the job and the lookup after a commit
 *   (DELIVERY_GEOCODING_DAILY_BUDGET);
 * - "address-search" and "address-search:<businessId>": the panel's
 *   search, the platform's day and each company's
 *   (ADDRESS_SEARCH_DAILY_BUDGET, ADDRESS_SEARCH_BUSINESS_DAILY_LIMIT);
 * - "proof-reverse": the proof's reverse lookup
 *   (PROOF_REVERSE_DAILY_BUDGET), which until then counted nowhere.
 *
 * It lived in a Redis key: an eviction gave the day back, and the provider
 * charged it. A unit is taken BEFORE the call, atomically and only below the
 * limit, so two replicas at the last unit never both ask.
 *
 * It fails CLOSED, unlike the request limiters: a limiter that fails open
 * costs a limit and spares a customer's call, but here failing open could
 * only spend money, while failing closed only delays a coordinate to the
 * next minute.
 *
 * During the rolling deploy that brings it, the previous image still counts
 * in the Redis key and reads it (legacy): each take starts from the greater
 * of the row and that key, and writes the key back as at least the row
 * (GREATEST, the mirror), so both images count the same day and neither
 * spends the other's calls again. An evicted key reads 0 and the row
 * stands. F2-36, a release after this one is in production, drops the key.
 */
interface GeocodingBudget {
  /** Lookups left today; 0 when unknown. */
  remaining(now: Date): Promise<number>;
  /**
   * One lookup, counted as it goes out; false when the day is spent or
   * cannot be counted (nothing is asked then).
   */
  take(now: Date): Promise<boolean>;
}

/** The account the geocoder's scopes count in (REVERSE_GEOCODER_*). */
const GEOCODER_PROVIDER = "geocoder";

const GEOCODING_SCOPES = {
  job: "geocoding-job",
  search: "address-search",
  searchBusiness: (businessId: string) => `address-search:${businessId}`,
  proof: "proof-reverse",
} as const;

/** A day and two hours, so the key of a day outlives the day itself. */
const WINDOW_SECONDS = 26 * 60 * 60;

/**
 * The previous image's count, kept in step: one more for the call, and
 * never below the row's count after the take (the evicted key, or the calls
 * the new image made before it had the key). Armed like
 * countInFixedWindow's window (fixed-window-counter.ts), so the old image's
 * INCR on the same key keeps its TTL.
 *
 * KEYS: the day's key. ARGV: the row's count, the window (s).
 */
const MIRROR_TAKE = [
  "local count = redis.call('INCR', KEYS[1])",
  "local floor = tonumber(ARGV[1])",
  "if count < floor then",
  "  redis.call('SET', KEYS[1], floor, 'KEEPTTL')",
  "  count = floor",
  "end",
  "if redis.call('PTTL', KEYS[1]) == -1 then",
  "  redis.call('EXPIRE', KEYS[1], ARGV[2])",
  "end",
  "return count",
].join("\n");

/** The previous image's Redis keys of a scope, read and kept in step. */
interface LegacyDayKey {
  redis: Pick<Redis, "get" | "eval">;
  key: (now: Date) => string;
  /**
   * The key unreadable or unwritable: the row still decides, so this is
   * only for the log, never a reason to put a lookup off.
   */
  onError?: (err: unknown) => void;
}

/** A Redis count as a number; anything else is 0. */
function countOf(value: string | null | undefined): number {
  const count = Number(value ?? 0);

  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

/**
 * The previous image's count of the day: 0 without one, and 0 when Redis
 * does not answer — the row is the day, the key only what the old replicas
 * spent beside it.
 */
async function legacyCount(
  legacy: LegacyDayKey | undefined,
  now: Date,
): Promise<number> {
  if (!legacy) return 0;

  try {
    return countOf(await legacy.redis.get(legacy.key(now)));
  } catch (err) {
    legacy.onError?.(err);

    return 0;
  }
}

/** Writes the row's count back to the previous image's key; never throws. */
async function mirror(
  legacy: LegacyDayKey | undefined,
  now: Date,
  used: number,
): Promise<void> {
  if (!legacy) return;

  try {
    await legacy.redis.eval(
      MIRROR_TAKE,
      1,
      legacy.key(now),
      used,
      WINDOW_SECONDS,
    );
  } catch (err) {
    // The call is going out anyway: an old replica may spend a unit or
    // two the row has, until the next take writes the key again.
    legacy.onError?.(err);
  }
}

interface GeocodingBudgetOptions {
  quota: IProviderQuotaRepository;
  scope: string;
  /** The day's limit, read at each call (the tests switch it). */
  limit: () => number;
  /** The previous image's key of this scope, during the rolling deploy. */
  legacy?: LegacyDayKey;
  onError?: (err: unknown) => void;
}

function createGeocodingBudget({
  quota,
  scope,
  limit,
  legacy,
  onError = () => undefined,
}: GeocodingBudgetOptions): GeocodingBudget {
  return {
    async remaining(now) {
      const ceiling = limit();

      if (ceiling <= 0) return 0;

      try {
        const [counts, old] = await Promise.all([
          quota.used(GEOCODER_PROVIDER, quotaDay(now), [scope]),
          legacyCount(legacy, now),
        ]);

        return Math.max(0, ceiling - Math.max(counts[scope] ?? 0, old));
      } catch (err) {
        onError(err);

        return 0;
      }
    },

    async take(now) {
      const ceiling = limit();

      if (ceiling <= 0) return false;

      try {
        const floor = await legacyCount(legacy, now);
        const taken = await quota.take(GEOCODER_PROVIDER, quotaDay(now), [
          { scope, limit: ceiling, floor },
        ]);

        if (!taken.granted) return false;

        await mirror(legacy, now, taken.used[0]);

        return true;
      } catch (err) {
        onError(err);

        return false;
      }
    },
  };
}

export {
  GEOCODER_PROVIDER,
  GEOCODING_SCOPES,
  MIRROR_TAKE,
  WINDOW_SECONDS,
  countOf,
  createGeocodingBudget,
  legacyCount,
  mirror,
};
export type { GeocodingBudget, GeocodingBudgetOptions, LegacyDayKey };
