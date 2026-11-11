import { createHmac, hkdfSync } from "node:crypto";

import type { Redis } from "ioredis";

import auth from "@/config/auth";
import {
  EXTEND_PAUSE,
  pauseDeadlineOf,
  pauseReasonOf,
  pauseValue,
  type GeocodingPauseReason,
} from "@/shared/delivery/geocoding/geocoding-gate";
import {
  GEOCODING_KEYS,
  type GeocodingKeys,
} from "@/shared/delivery/geocoding/geocoding-keys";
import { countInFixedWindow } from "@/shared/services/fixed-window-counter";
import {
  isSealed,
  openSecret,
  sealSecret,
} from "@/shared/integration/secret-box";

import type { RankedSearch } from "./address-search-ranking";

/**
 * What the panel's address search keeps in Redis (plan pin-search): the
 * answers, per company; the day's counts, the platform's and each
 * company's; and the search's own pause.
 *
 * - The cache is PER COMPANY: one carrier must not learn, from how fast an
 *   answer came, what another searched. Its key is an HMAC of the search,
 *   never the text: what was typed can be a recipient's address. Its value
 *   is sealed (AES-256-GCM, secret-box.ts): the suggestions of a door search
 *   ("Rua Epitácio Pessoa, 120") are the address typed, near enough. A hit
 *   spends nothing. Unreadable, it is a miss; unwritable, it is skipped.
 * - The counts fail CLOSED, as the job's budget does (geocoding-budget.ts):
 *   unreadable, nothing is asked. They are spent only when a call goes out.
 * - The search's pause holds only the search. A refusal of its endpoint (a
 *   key without the autocomplete, a URL off by a segment) says nothing
 *   about the deliveries' lookups, which call another endpoint and keep
 *   working. The day's quota and a burst are the account's: they go to the
 *   shared pause (geocoding-gate.ts) AND here, because the shared key never
 *   takes a shorter pause over a longer one — behind the deliveries' own
 *   15-min REFUSED, which the search ignores, a burst would be lost and the
 *   search would go on asking through it.
 *
 * The keys are the geocoder's (geocoding-keys.ts), on the request path's
 * fail-fast connection (http.ts).
 */
interface SearchPause {
  reason: GeocodingPauseReason;
  /** Null when the value has no readable deadline. */
  until: Date | null;
}

interface SearchStanding {
  /** The account's pause (the day's quota, a burst), while one runs. */
  accountPause: SearchPause | null;
  /** The search's own pause (a refusal, or its copy of the account's). */
  searchPause: SearchPause | null;
  platformUsed: number;
  businessUsed: number;
}

/** What the cache keeps: the ranked answer, ready to send. */
type CachedSearch = RankedSearch;

interface AddressSearchStore {
  /** A company's cached answer; null for none or Redis unreadable. */
  cached(businessId: string, digest: string): Promise<CachedSearch | null>;

  /** Keeps an answer for `seconds`; a failure only loses the copy. */
  remember(
    businessId: string,
    digest: string,
    answer: CachedSearch,
    seconds: number,
  ): Promise<void>;

  /** The pauses and today's counts in one read; null when unreadable. */
  standing(businessId: string, now: Date): Promise<SearchStanding | null>;

  /** One call made: the platform's and the company's day. */
  spend(businessId: string, now: Date): Promise<void>;

  /** Pauses the search alone until `until`; never shortens a longer one. */
  pauseSearch(
    reason: GeocodingPauseReason,
    until: Date,
    now: Date,
  ): Promise<void>;
}

/** A day and two hours, so the key of a day outlives the day itself. */
const DAY_WINDOW_SECONDS = 26 * 60 * 60;

const hmacKey = Buffer.from(
  hkdfSync(
    "sha256",
    auth.secret_token,
    "",
    "trajetto/address-search-cache",
    32,
  ),
);

/** The value's key: the same secret, another label. */
const sealKey = Buffer.from(
  hkdfSync(
    "sha256",
    auth.secret_token,
    "",
    "trajetto/address-search-cache-value",
    32,
  ),
);

/**
 * The cache key of a search: an HMAC under a key derived from JWT_SECRET
 * (its own label), so a Redis dump does not hand over what was typed — an
 * unkeyed hash of an address is a dictionary lookup away.
 */
function searchDigest(material: string): string {
  return createHmac("sha256", hmacKey).update(material).digest("hex");
}

function count(value: string | null | undefined): number {
  const used = Number(value ?? 0);

  return Number.isFinite(used) ? used : 0;
}

/** An answer as the cache keeps it: sealed, never in clear. */
function sealCached(answer: CachedSearch): string {
  return sealSecret(JSON.stringify(answer), sealKey);
}

/**
 * A cached answer as it was written, or null for anything else: a value not
 * sealed, one sealed under another JWT_SECRET (rotated), one tampered with.
 */
function parseCached(raw: string | null): CachedSearch | null {
  if (!raw || !isSealed(raw)) return null;

  try {
    const parsed = JSON.parse(
      openSecret(raw, sealKey),
    ) as Partial<CachedSearch>;

    return Array.isArray(parsed.results) && typeof parsed.weak === "boolean"
      ? { results: parsed.results, weak: parsed.weak }
      : null;
  } catch {
    return null;
  }
}

/** A pause key's reason and deadline; REFUSED for a value of no reason. */
function searchPauseOf(
  value: string | null | undefined,
  now: Date,
): SearchPause | null {
  if (!value) return null;

  return {
    reason: pauseReasonOf(value) ?? "REFUSED",
    until: pauseDeadlineOf(value) ?? now,
  };
}

function createRedisAddressSearchStore(
  redis: Pick<Redis, "eval" | "get" | "mget" | "set">,
  onError: (err: unknown) => void = () => undefined,
  keys: GeocodingKeys = GEOCODING_KEYS,
): AddressSearchStore {
  return {
    async cached(businessId, digest) {
      try {
        return parseCached(
          await redis.get(keys.searchCache(businessId, digest)),
        );
      } catch (err) {
        onError(err);

        return null;
      }
    },

    async remember(businessId, digest, answer, seconds) {
      if (seconds <= 0) return;

      try {
        await redis.set(
          keys.searchCache(businessId, digest),
          sealCached(answer),
          "EX",
          seconds,
        );
      } catch (err) {
        onError(err);
      }
    },

    async standing(businessId, now) {
      try {
        const [shared, own, platform, business] = await redis.mget(
          keys.pause,
          keys.searchPause,
          keys.searchDay(now),
          keys.searchBusinessDay(now, businessId),
        );

        // A refusal of the deliveries' lookups is theirs: their endpoint,
        // not this one.
        const reason = pauseReasonOf(shared);

        return {
          accountPause:
            reason === "QUOTA" || reason === "BURST"
              ? { reason, until: pauseDeadlineOf(shared) }
              : null,
          searchPause: searchPauseOf(own, now),
          platformUsed: count(platform),
          businessUsed: count(business),
        };
      } catch (err) {
        onError(err);

        return null;
      }
    },

    async spend(businessId, now) {
      try {
        await Promise.all([
          countInFixedWindow(redis, keys.searchDay(now), DAY_WINDOW_SECONDS),
          countInFixedWindow(
            redis,
            keys.searchBusinessDay(now, businessId),
            DAY_WINDOW_SECONDS,
          ),
        ]);
      } catch (err) {
        // The call went out: a count lost costs a search or two too many.
        onError(err);
      }
    },

    async pauseSearch(reason, until, now) {
      const ms = Math.ceil(until.getTime() - now.getTime());

      if (ms <= 0) return;

      try {
        await redis.eval(
          EXTEND_PAUSE,
          1,
          keys.searchPause,
          pauseValue(reason, until),
          ms,
        );
      } catch (err) {
        onError(err);
      }
    },
  };
}

/** For paths with no Redis (unit tests, scripts): nothing can be counted. */
const unreadableAddressSearchStore: AddressSearchStore = {
  cached: async () => null,
  remember: async () => undefined,
  standing: async () => null,
  spend: async () => undefined,
  pauseSearch: async () => undefined,
};

export {
  DAY_WINDOW_SECONDS,
  createRedisAddressSearchStore,
  parseCached,
  sealCached,
  searchDigest,
  unreadableAddressSearchStore,
};
export type { AddressSearchStore, CachedSearch, SearchPause, SearchStanding };
