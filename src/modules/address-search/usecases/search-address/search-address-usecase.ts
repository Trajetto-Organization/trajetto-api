import { foldText } from "@/shared/utils/fold-text";
import type { GeocodingGate } from "@/shared/delivery/geocoding/geocoding-gate";
import {
  REFUSED_PAUSE_MS,
  SHORT_RATE_PAUSE_MS,
  nextUtcMidnight,
} from "@/shared/delivery/geocoding/delivery-geocoding-service";
import type {
  AddressSearchProviderConfig,
  ProviderAnswer,
  ProviderSearch,
} from "@/shared/services/address-search/address-search-provider";
import type {
  AddressSearchStore,
  SearchPause,
} from "@/shared/services/address-search/address-search-limits";
import { searchDigest } from "@/shared/services/address-search/address-search-limits";
import {
  rankSuggestions,
  scopedText,
  type AddressSuggestion,
  type SearchHint,
} from "@/shared/services/address-search/address-search-ranking";

import type { Viewbox } from "../../schemas/address-search-schemas";

/**
 * The panel's address search ("Fixar no mapa", plan pin-search): the
 * places for what a dispatcher is typing, from the provider the geocoder
 * already pays for, behind the server — the key never reaches a browser,
 * and every carrier's searches go through one cache, one budget and the
 * provider's rate, not through each tab.
 *
 * In this order, each step cheaper than the next:
 *
 * 1. the company's cache (a hit spends nothing, even with the search off
 *    or paused);
 * 2. on at all (a URL and a budget);
 * 3. the pauses and today's counts, in one read that fails CLOSED: the
 *    account's pause (the day's quota, a burst) and the search's own (a
 *    refusal, or its copy of the account's); the platform's day and the
 *    company's;
 * 4. a slot of the provider's rate, the one the deliveries' lookups take
 *    (geocoding-gate.ts: a call a second, 50 in any 60 s, the last ten of
 *    them the search's), waited for a little and never once the person
 *    gave up;
 * 5. the call, counted in both days as it goes out;
 * 6. the ranking (address-search-ranking.ts), and the cache.
 *
 * A refusal (the key, the URL) pauses the search alone for 15 min, never
 * the deliveries' lookups, which call another endpoint; a rejection of the
 * text a person typed (a 400) fails that search alone. The day's quota and
 * a burst are the account's and pause every path (geocoding-gate.ts), the
 * search on its own key too.
 *
 * The log line has the company, the outcome, the provider's status, the
 * time and whether it came from the cache — never what was typed (it can
 * be a recipient's address) and never the URL (it carries the key).
 */
interface AddressSearchSettings {
  provider: AddressSearchProviderConfig | null;
  dailyBudget: number;
  businessDailyLimit: number;
  cacheSeconds: number;
}

interface SearchAddressRequest {
  businessId: string;
  /** Spaces collapsed, 3 to 200 characters. */
  query: string;
  hint: SearchHint | null;
  viewbox: Viewbox | null;
  limit: number;
  /** Aborted when the person typed again or left. */
  signal: AbortSignal;
}

type SearchScope = "CITY" | "COUNTRY";

type SearchAddressResult =
  | {
      kind: "OK";
      results: AddressSuggestion[];
      weak: boolean;
      scope: SearchScope;
      cached: boolean;
    }
  | {
      kind: "DAILY_LIMIT";
      scope: "BUSINESS" | "PLATFORM";
      retryAfterSeconds: number;
    }
  | {
      kind: "UNAVAILABLE";
      /** PROVIDER: refused (paused), rejected the text, or failed. */
      reason: "DISABLED" | "PAUSED" | "PROVIDER" | "LIMITS_UNREADABLE";
      retryAfterSeconds: number;
    }
  | { kind: "BUSY"; retryAfterSeconds: number }
  | { kind: "ABORTED" };

interface SearchLog {
  info(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
  error(details: Record<string, unknown>, message: string): void;
}

interface SearchAddressDeps {
  settings: () => AddressSearchSettings;
  store: AddressSearchStore;
  gate: Pick<GeocodingGate, "pause" | "takeSlot">;
  provider: (
    config: AddressSearchProviderConfig,
    search: ProviderSearch,
    signal: AbortSignal,
  ) => Promise<ProviderAnswer>;
  log: SearchLog;
  clock?: () => Date;
  options?: Partial<SearchAddressOptions>;
}

interface SearchAddressOptions {
  /** How many times to try for the provider's slot. */
  slotTries: number;
  /**
   * The wait between two tries. Three tries 500 ms apart span a second:
   * the last always falls in the next one, whatever took this one.
   */
  slotWaitMs: number;
}

const SEARCH_ADDRESS_DEFAULTS: SearchAddressOptions = {
  slotTries: 3,
  slotWaitMs: 500,
};

/** A search's result, with what its log line says about the provider. */
interface Settled {
  result: SearchAddressResult;
  /** The provider's HTTP status, when it was called and answered. */
  status?: number | null;
  /** The provider refused the request: configuration, error level. */
  refused?: boolean;
  /** The provider rejected this text (a 400): warn, nothing paused. */
  rejected?: boolean;
  /** The provider answered 429. */
  limited?: boolean;
}

/** Nothing found is kept for less: the map may have the street tomorrow. */
const NOT_FOUND_CACHE_SECONDS = 600;

/** The cache key's version: a change of shape is a new key, not a misread. */
const CACHE_VERSION = "v1";

/** Seconds until `until`, at least one. */
function secondsUntil(until: Date | null, now: Date, fallback: number): number {
  if (!until) return fallback;

  return Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 1000));
}

/** The deadline furthest away; null when none of them has one. */
function latest(holds: ReadonlyArray<SearchPause>): Date | null {
  return holds.reduce<Date | null>(
    (furthest, hold) =>
      hold.until && (!furthest || hold.until > furthest)
        ? hold.until
        : furthest,
    null,
  );
}

/** Waits `ms`, or less when the person gives up. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) {
      resolve();
      return;
    }

    const timer = setTimeout(done, ms);

    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }

    signal.addEventListener("abort", done, { once: true });
  });
}

class SearchAddressUseCase {
  private readonly options: SearchAddressOptions;
  private readonly clock: () => Date;

  constructor(private readonly deps: SearchAddressDeps) {
    this.options = { ...SEARCH_ADDRESS_DEFAULTS, ...deps.options };
    this.clock = deps.clock ?? (() => new Date());
  }

  async execute(request: SearchAddressRequest): Promise<SearchAddressResult> {
    const started = this.clock();
    const { result, status, refused, rejected, limited } = await this.search(
      request,
      started,
    );

    const line = {
      businessId: request.businessId,
      outcome:
        result.kind === "UNAVAILABLE"
          ? `UNAVAILABLE_${result.reason}`
          : result.kind === "DAILY_LIMIT"
            ? `DAILY_LIMIT_${result.scope}`
            : result.kind,
      status: status ?? null,
      ms: this.clock().getTime() - started.getTime(),
      cached: result.kind === "OK" ? result.cached : false,
    };

    if (refused) {
      this.deps.log.error(
        line,
        "address search provider refused the request: check ADDRESS_SEARCH_URL, ADDRESS_SEARCH_PROTOCOL and the key; search paused for 15 min",
      );
    } else if (rejected) {
      this.deps.log.warn(
        line,
        "address search provider rejected the text; nothing paused",
      );
    } else if (limited) {
      this.deps.log.warn(line, "address search rate-limited by the provider");
    } else {
      this.deps.log.info(line, "address search");
    }

    return result;
  }

  private async search(
    request: SearchAddressRequest,
    now: Date,
  ): Promise<Settled> {
    const settings = this.deps.settings();
    const scope: SearchScope = request.hint ? "CITY" : "COUNTRY";
    const digest = searchDigest(
      [
        CACHE_VERSION,
        settings.provider?.protocol ?? "off",
        foldText(request.query),
        request.hint
          ? `${foldText(request.hint.city)}|${request.hint.uf}`
          : "-",
        request.viewbox?.map((side) => side.toFixed(2)).join(",") ?? "-",
        request.limit,
      ].join("|"),
    );

    if (settings.cacheSeconds > 0) {
      const cached = await this.deps.store.cached(request.businessId, digest);

      if (cached) {
        return { result: { kind: "OK", ...cached, scope, cached: true } };
      }
    }

    if (!settings.provider || settings.dailyBudget <= 0) {
      return {
        result: {
          kind: "UNAVAILABLE",
          reason: "DISABLED",
          retryAfterSeconds: 3600,
        },
      };
    }

    const standing = await this.deps.store.standing(request.businessId, now);

    if (!standing) {
      return {
        result: {
          kind: "UNAVAILABLE",
          reason: "LIMITS_UNREADABLE",
          retryAfterSeconds: 30,
        },
      };
    }

    // A refusal or the day's quota holds the search for long; a burst only
    // for its minute. The longer one answers when both run.
    const held = [standing.accountPause, standing.searchPause].filter(
      (hold): hold is SearchPause => hold !== null,
    );
    const long = held.filter((hold) => hold.reason !== "BURST");

    if (long.length > 0) {
      return {
        result: {
          kind: "UNAVAILABLE",
          reason: "PAUSED",
          retryAfterSeconds: secondsUntil(latest(long), now, 900),
        },
      };
    }

    if (held.length > 0) {
      return {
        result: {
          kind: "BUSY",
          retryAfterSeconds: secondsUntil(latest(held), now, 60),
        },
      };
    }

    const midnight = secondsUntil(nextUtcMidnight(now), now, 3600);

    if (standing.platformUsed >= settings.dailyBudget) {
      return {
        result: {
          kind: "DAILY_LIMIT",
          scope: "PLATFORM",
          retryAfterSeconds: midnight,
        },
      };
    }

    if (standing.businessUsed >= settings.businessDailyLimit) {
      return {
        result: {
          kind: "DAILY_LIMIT",
          scope: "BUSINESS",
          retryAfterSeconds: midnight,
        },
      };
    }

    if (!(await this.slot(request.signal))) {
      return {
        result: request.signal.aborted
          ? { kind: "ABORTED" }
          : { kind: "BUSY", retryAfterSeconds: 1 },
      };
    }

    // Counted as the call goes out, whatever comes back: the provider
    // counts it too.
    await this.deps.store.spend(request.businessId, now);

    const answer = await this.deps.provider(
      settings.provider,
      {
        text: scopedText(request.query, request.hint),
        viewbox: request.viewbox,
      },
      request.signal,
    );

    return this.settle(answer, request, settings, digest, scope);
  }

  private async settle(
    answer: ProviderAnswer,
    request: SearchAddressRequest,
    settings: AddressSearchSettings,
    digest: string,
    scope: SearchScope,
  ): Promise<Settled> {
    const now = this.clock();

    switch (answer.kind) {
      case "FOUND":
      case "NOT_FOUND": {
        const ranked =
          answer.kind === "FOUND"
            ? rankSuggestions(answer.places, {
                query: request.query,
                hint: request.hint,
                viewbox: request.viewbox,
                limit: request.limit,
              })
            : { results: [], weak: false };

        await this.deps.store.remember(
          request.businessId,
          digest,
          ranked,
          ranked.results.length > 0
            ? settings.cacheSeconds
            : Math.min(settings.cacheSeconds, NOT_FOUND_CACHE_SECONDS),
        );

        return {
          result: { kind: "OK", ...ranked, scope, cached: false },
          status: 200,
        };
      }

      case "REFUSED":
        await this.deps.store.pauseSearch(
          "REFUSED",
          new Date(now.getTime() + REFUSED_PAUSE_MS),
          now,
        );

        return {
          result: {
            kind: "UNAVAILABLE",
            reason: "PROVIDER",
            retryAfterSeconds: REFUSED_PAUSE_MS / 1000,
          },
          status: answer.status,
          refused: true,
        };

      case "REJECTED":
        // This text, not the account: nothing paused, nothing cached.
        return {
          result: {
            kind: "UNAVAILABLE",
            reason: "PROVIDER",
            retryAfterSeconds: 5,
          },
          status: answer.status,
          rejected: true,
        };

      case "RATE_LIMITED": {
        // The account's: every path waits, the deliveries' lookups too
        // (the shared pause), and the search on its own key as well — the
        // shared one keeps a longer pause of the deliveries' over this.
        const [reason, until] =
          answer.scope === "DAY"
            ? (["QUOTA", nextUtcMidnight(now)] as const)
            : ([
                "BURST",
                new Date(now.getTime() + SHORT_RATE_PAUSE_MS),
              ] as const);

        await Promise.all([
          this.deps.gate.pause(until, now, reason),
          this.deps.store.pauseSearch(reason, until, now),
        ]);

        if (reason === "QUOTA") {
          return {
            result: {
              kind: "UNAVAILABLE",
              reason: "PAUSED",
              retryAfterSeconds: secondsUntil(until, now, 3600),
            },
            status: answer.status,
            limited: true,
          };
        }

        return {
          result: {
            kind: "BUSY",
            retryAfterSeconds: SHORT_RATE_PAUSE_MS / 1000,
          },
          status: answer.status,
          limited: true,
        };
      }

      case "FAILED":
        return {
          result: {
            kind: "UNAVAILABLE",
            reason: "PROVIDER",
            retryAfterSeconds: 5,
          },
          status: answer.status,
        };

      case "ABORTED":
        return { result: { kind: "ABORTED" } };
    }
  }

  /**
   * The provider's slot, a few tries apart; never once the person left.
   * One taken in the round trip the person gave up in is let go unused: it
   * is a second of the shared rate, and the call would spend the
   * company's day on an answer nobody reads.
   */
  private async slot(signal: AbortSignal): Promise<boolean> {
    for (let attempt = 1; attempt <= this.options.slotTries; attempt += 1) {
      if (signal.aborted) return false;

      if (await this.deps.gate.takeSlot()) return !signal.aborted;

      if (attempt < this.options.slotTries) {
        await pause(this.options.slotWaitMs, signal);
      }
    }

    return false;
  }
}

export {
  NOT_FOUND_CACHE_SECONDS,
  SEARCH_ADDRESS_DEFAULTS,
  SearchAddressUseCase,
};
export type {
  AddressSearchSettings,
  SearchAddressDeps,
  SearchAddressRequest,
  SearchAddressResult,
  SearchLog,
  SearchScope,
};
