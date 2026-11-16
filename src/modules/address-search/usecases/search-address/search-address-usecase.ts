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
 * 5. the call, counted in both days as it goes out (taken in Postgres,
 *    both or neither, only below the limits);
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
 * be a recipient's address) and never the URL (it carries the key). When
 * the search cannot answer, it also says why (`reason`): the variable that
 * turned it off, the pause that holds it (its reason, deadline and the
 * provider's status), or what a refusal's status means. Until 14/11/2026 a
 * staging without ADDRESS_SEARCH_URL logged only UNAVAILABLE_DISABLED, and
 * nobody could tell it from a refused key.
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
      /**
       * Why, for the log only (ServiceBusyError's diagnostic): off, paused
       * or refused. Never what was typed, the URL or the key.
       */
      diagnostic?: string;
    }
  | { kind: "BUSY"; retryAfterSeconds: number }
  | { kind: "ABORTED" };

interface SearchLog {
  info(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
  error(details: Record<string, unknown>, message: string): void;
}

/**
 * Whether this process already said the search is off, and why: the first
 * search that finds it off logs at warn, the rest at info, like the job's
 * offLogged (geocode-deliveries-job.ts). A staging without the variable
 * shows why at a level anybody sees, without a warn per keystroke.
 */
interface AddressSearchOffNotice {
  said: string | null;
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
  /** The process's (search-address-runtime.ts); this use case's by default. */
  offNotice?: AddressSearchOffNotice;
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
  /** The log line's `reason`: why the search could not answer. */
  cause?: string | Record<string, unknown>;
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

/**
 * Why the search is off, for the log; null when it is on. The sibling of
 * deliveryGeocodingOffReason (geocoding-enabled.ts): the provider exists
 * only with ADDRESS_SEARCH_URL (search-address-runtime.ts).
 */
function addressSearchOffReason(
  settings: Pick<AddressSearchSettings, "provider" | "dailyBudget">,
): string | null {
  if (!settings.provider) return "ADDRESS_SEARCH_URL is not set";

  if (settings.dailyBudget <= 0) return "ADDRESS_SEARCH_DAILY_BUDGET is 0";

  return null;
}

/**
 * What a refusal's HTTP status means to whoever configures the search
 * (address-search-provider.ts: a 401, a 403, a 404 without the provider's
 * error, or a 200 that is not a list). Names the variables, never their
 * values.
 */
function searchRefusalHint(status: number | null): string {
  switch (status) {
    case 401:
      return "HTTP 401: the provider refused the key; check ADDRESS_SEARCH_KEY (REVERSE_GEOCODER_KEY is used when it is empty)";
    case 403:
      return "HTTP 403: the key is not allowed this endpoint; on LocationIQ, enable Autocomplete on the token and remove any referrer or IP restriction";
    case 404:
      return "HTTP 404: ADDRESS_SEARCH_URL is not the API's root (the /v1, without the endpoint), or ADDRESS_SEARCH_PROTOCOL does not match the provider";
    case 200:
      return "HTTP 200 that is not a list: ADDRESS_SEARCH_URL answers a page, not the provider's API; check it and ADDRESS_SEARCH_PROTOCOL";
    default:
      return `HTTP ${status ?? "?"}: refused; check ADDRESS_SEARCH_URL, ADDRESS_SEARCH_PROTOCOL and the key`;
  }
}

/** The pause that answers, as the log line's `reason`. */
function pauseCause(hold: SearchPause): Record<string, unknown> {
  return {
    pauseReason: hold.reason,
    until: hold.until?.toISOString() ?? null,
    refusedStatus: hold.reason === "REFUSED" ? hold.status : null,
  };
}

/** The same in one sentence, for the error's diagnostic. */
function pauseDiagnostic(hold: SearchPause): string {
  const status = hold.status ? ` (HTTP ${hold.status})` : "";
  const until = hold.until?.toISOString() ?? "an unknown deadline";
  const hint =
    hold.reason === "REFUSED" && hold.status
      ? `; ${searchRefusalHint(hold.status)}`
      : "";

  return `address search paused by ${hold.reason}${status} until ${until}${hint}`;
}

/** The pause furthest away: the one the answer waits out. */
function longest(holds: ReadonlyArray<SearchPause>): SearchPause {
  return holds.reduce((furthest, hold) =>
    hold.until && (!furthest.until || hold.until > furthest.until)
      ? hold
      : furthest,
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
  private readonly offNotice: AddressSearchOffNotice;

  constructor(private readonly deps: SearchAddressDeps) {
    this.options = { ...SEARCH_ADDRESS_DEFAULTS, ...deps.options };
    this.clock = deps.clock ?? (() => new Date());
    this.offNotice = deps.offNotice ?? { said: null };
  }

  async execute(request: SearchAddressRequest): Promise<SearchAddressResult> {
    const started = this.clock();
    const { result, status, refused, rejected, limited, cause } =
      await this.search(request, started);

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
      ...(cause !== undefined && { reason: cause }),
    };

    const off =
      result.kind === "UNAVAILABLE" && result.reason === "DISABLED"
        ? (result.diagnostic ?? null)
        : null;

    if (off && this.offNotice.said !== off) {
      this.offNotice.said = off;
      this.deps.log.warn(
        line,
        "address search off: every search answers ADDRESS_SEARCH_DISABLED until the variable is set and the API redeployed; the map click still pins",
      );
    } else if (refused) {
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

    const off = addressSearchOffReason(settings);

    // Off whenever there is no provider: the second test is the compiler's.
    if (off !== null || !settings.provider) {
      const why = off ?? "ADDRESS_SEARCH_URL is not set";

      return {
        result: {
          kind: "UNAVAILABLE",
          reason: "DISABLED",
          retryAfterSeconds: 3600,
          diagnostic: why,
        },
        cause: why,
      };
    }

    // On (again, when a test switched it): the next time off is news.
    this.offNotice.said = null;

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
      const hold = longest(long);

      return {
        result: {
          kind: "UNAVAILABLE",
          reason: "PAUSED",
          retryAfterSeconds: secondsUntil(hold.until, now, 900),
          diagnostic: pauseDiagnostic(hold),
        },
        cause: pauseCause(hold),
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
    // counts it too. Taken, not added (F2-32): two searches at the last
    // unit of the day never both go out.
    const taken = await this.deps.store.take(request.businessId, now, {
      platform: settings.dailyBudget,
      business: settings.businessDailyLimit,
    });

    if (taken === null) {
      return {
        result: {
          kind: "UNAVAILABLE",
          reason: "LIMITS_UNREADABLE",
          retryAfterSeconds: 30,
        },
      };
    }

    if (taken !== "OK") {
      return {
        result: {
          kind: "DAILY_LIMIT",
          scope: taken,
          retryAfterSeconds: midnight,
        },
      };
    }

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

      case "REFUSED": {
        const hint = searchRefusalHint(answer.status);

        await this.deps.store.pauseSearch(
          "REFUSED",
          new Date(now.getTime() + REFUSED_PAUSE_MS),
          now,
          answer.status,
        );

        return {
          result: {
            kind: "UNAVAILABLE",
            reason: "PROVIDER",
            retryAfterSeconds: REFUSED_PAUSE_MS / 1000,
            diagnostic: hint,
          },
          status: answer.status,
          refused: true,
          cause: hint,
        };
      }

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
          this.deps.gate.pause(until, now, reason, answer.status),
          this.deps.store.pauseSearch(reason, until, now, answer.status),
        ]);

        if (reason === "QUOTA") {
          const hold: SearchPause = { reason, until, status: answer.status };

          return {
            result: {
              kind: "UNAVAILABLE",
              reason: "PAUSED",
              retryAfterSeconds: secondsUntil(until, now, 3600),
              diagnostic: pauseDiagnostic(hold),
            },
            status: answer.status,
            limited: true,
            cause: pauseCause(hold),
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
  addressSearchOffReason,
  searchRefusalHint,
};
export type {
  AddressSearchOffNotice,
  AddressSearchSettings,
  SearchAddressDeps,
  SearchAddressRequest,
  SearchAddressResult,
  SearchLog,
  SearchScope,
};
