import type { Redis } from "ioredis";

import { env } from "@/env";
import { logger } from "@/shared/logging/logger";
import {
  createRedisGeocodingGate,
  geocodingRatesFromEnv,
  type GeocodingGate,
} from "@/shared/delivery/geocoding/geocoding-gate";
import {
  GEOCODING_KEYS,
  type GeocodingKeys,
} from "@/shared/delivery/geocoding/geocoding-keys";
import {
  createRedisAddressSearchStore,
  unreadableAddressSearchStore,
  type AddressSearchStore,
} from "@/shared/services/address-search/address-search-limits";
import { searchPlaces } from "@/shared/services/address-search/address-search-provider";
import {
  ProviderQuotaRepository,
  type IProviderQuotaRepository,
} from "@/shared/services/provider-quota/provider-quota-repository";
import { proofLocationConfigFromEnv } from "@/shared/services/proof-location/proof-location-service";

import {
  SearchAddressUseCase,
  type AddressSearchOffNotice,
  type AddressSearchSettings,
} from "./search-address-usecase";

/**
 * The address search as the process runs it: the settings from
 * ADDRESS_SEARCH_* (read on every search, so a test can change them; the
 * env itself is read once, at boot, so a change in the Dokploy Environment
 * needs a redeploy), the provider over fetch, and the cache, the counts and
 * the provider's gate on the request path's fail-fast Redis connection —
 * the rate-limit one, wired in http.ts like the geocoding hold. A search
 * waits on Redis for 250 ms at most, and an unreadable Redis answers 503
 * instead of calling.
 */
const log = logger.child({ component: "address-search" });

/** The process's: the search off is a warn once, then info per search. */
const offNotice: AddressSearchOffNotice = { said: null };

/** The provider is a person's wait: never longer than this. */
const SEARCH_TIMEOUT_CEILING_MS = 2_500;

/** Unwired (unit tests, scripts): nothing can be counted, nothing is asked. */
const closedGate: Pick<GeocodingGate, "pause" | "takeSlot"> = {
  pause: async () => undefined,
  takeSlot: async () => false,
};

let store: AddressSearchStore = unreadableAddressSearchStore;
let gate: Pick<GeocodingGate, "pause" | "takeSlot"> = closedGate;

/**
 * Wires the search on `redis`, and its day's counts on Postgres (F2-32).
 * The keys are production's, shared with the deliveries' lookups of every
 * replica; only an E2E file passes keys of its own, so another run on the
 * same Redis never shares its slots or pauses.
 */
function configureAddressSearch(
  redis: Redis,
  keys: GeocodingKeys = GEOCODING_KEYS,
  quota: IProviderQuotaRepository = new ProviderQuotaRepository(),
): void {
  // Debug, not warn: during an outage every search would write a line, and
  // the connection log already says Redis is gone.
  const onError = (err: unknown) =>
    log.debug({ err }, "address search limits unreadable");

  store = createRedisAddressSearchStore(redis, quota, onError, keys);
  // The search's ceiling in the minute: the background paths stop sooner
  // on the same count (GEOCODING_BACKGROUND_CALLS_PER_MINUTE).
  const rates = geocodingRatesFromEnv();

  gate = createRedisGeocodingGate(redis, {
    perSecond: rates.perSecond,
    perMinute: rates.perMinute,
    onError,
    keys,
  });
}

function addressSearchSettingsFromEnv(): AddressSearchSettings {
  const geocoder = proofLocationConfigFromEnv().geocoder;

  return {
    provider: env.ADDRESS_SEARCH_URL
      ? {
          url: env.ADDRESS_SEARCH_URL,
          protocol: env.ADDRESS_SEARCH_PROTOCOL,
          // The same account as the deliveries' lookups unless a token of
          // its own is set.
          key: env.ADDRESS_SEARCH_KEY ?? env.REVERSE_GEOCODER_KEY,
          keyParam: geocoder.keyParam,
          userAgent: geocoder.userAgent,
          timeoutMs: Math.min(geocoder.timeoutMs, SEARCH_TIMEOUT_CEILING_MS),
        }
      : null,
    dailyBudget: env.ADDRESS_SEARCH_DAILY_BUDGET,
    businessDailyLimit: env.ADDRESS_SEARCH_BUSINESS_DAILY_LIMIT,
    cacheSeconds: env.ADDRESS_SEARCH_CACHE_SECONDS,
  };
}

function searchAddressUseCase(): SearchAddressUseCase {
  return new SearchAddressUseCase({
    settings: addressSearchSettingsFromEnv,
    store,
    gate,
    provider: searchPlaces,
    log,
    offNotice,
  });
}

export {
  SEARCH_TIMEOUT_CEILING_MS,
  addressSearchSettingsFromEnv,
  configureAddressSearch,
  searchAddressUseCase,
};
