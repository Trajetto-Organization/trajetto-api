/**
 * Where the geocoder keeps its state in Redis (ADR 0002, addendum of
 * 10/11/2026): the job's day, the provider's gate — the second's window,
 * the minute's log, the account's pause — and the address search's own
 * pause, day counts and cache. One namespace holds them all.
 *
 * Production has ONE namespace, GEOCODING_KEYS (`geocoding`), and it must
 * stay one: every replica — the old and the new alike during a rolling
 * deploy — counts the same second and the same minute and honours the same
 * pause, or together they pass the provider's rate. The factories
 * (geocoding-gate.ts, geocoding-budget.ts, geocoding-hold.ts,
 * address-search-limits.ts) default to it, and nothing in src names
 * another (tests/unitaires/delivery/geocoding-keys.test.ts).
 *
 * Another namespace is for an E2E run
 * (tests/E2E/support/geocoding-test-keys.ts): its Redis outlives it and can
 * serve another run at the same time, and with slots, pauses and counts of
 * its own, another run's call never takes its second, nor does a pause or a
 * day's count one left answer it.
 */
interface GeocodingKeys {
  /** The job's lookups of a UTC day (geocoding-budget.ts). */
  budget(now: Date): string;
  /** A second's window of the provider's rate (geocoding-gate.ts). */
  second(epochSecond: number): string;
  /** The log of the gated calls of the last 60 s. */
  minute: string;
  /** The account's pause: the job's, and the search's quota and burst. */
  pause: string;
  /** The address search's own pause (address-search-limits.ts). */
  searchPause: string;
  /** The platform's searches of a UTC day. */
  searchDay(now: Date): string;
  /** One company's searches of a UTC day. */
  searchBusinessDay(now: Date, businessId: string): string;
  /** One company's cached answer to a search, named by its HMAC. */
  searchCache(businessId: string, digest: string): string;
}

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function geocodingKeys(namespace: string): GeocodingKeys {
  return {
    budget: (now) => `${namespace}:deliveries:${utcDay(now)}`,
    // Named after the deliveries, as it was before the search shared it:
    // the old replicas and the new count in the same key.
    second: (epochSecond) => `${namespace}:deliveries:rate:${epochSecond}`,
    minute: `${namespace}:provider:minute`,
    pause: `${namespace}:deliveries:paused`,
    searchPause: `${namespace}:search:paused`,
    searchDay: (now) => `${namespace}:search:${utcDay(now)}`,
    searchBusinessDay: (now, businessId) =>
      `${namespace}:search:${utcDay(now)}:${businessId}`,
    searchCache: (businessId, digest) =>
      `${namespace}:search:cache:${businessId}:${digest}`,
  };
}

/** Production's keys, shared by every replica. */
const GEOCODING_KEYS = geocodingKeys("geocoding");

export { GEOCODING_KEYS, geocodingKeys };
export type { GeocodingKeys };
