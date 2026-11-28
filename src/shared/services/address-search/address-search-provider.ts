import type { Viewbox } from "@/modules/address-search/schemas/address-search-schemas";
import {
  jsonBody,
  refusalOf,
  searchRequestUrl,
} from "@/shared/services/proof-location/address-geocoder";
import type { GeocodeFetch } from "@/shared/services/proof-location/reverse-geocoder";

/**
 * The provider behind the panel's address search ("Fixar no mapa", plan
 * pin-search): a list of places for a text a person is still typing.
 *
 * Two protocols on one interface:
 *
 * - `locationiq-autocomplete`: LocationIQ's /autocomplete, made for search
 *   as you type (on https://api.locationiq.com/v1, not the regional host of
 *   REVERSE_GEOCODER_URL). One credit a call, like a search. Only the
 *   parameters its documentation lists for the endpoint: an unknown one
 *   answered 400 would read as a refusal and pause the search;
 * - `nominatim-search`: the /search of a Nominatim of our own, or of a
 *   development stack, with the forward geocoder's request
 *   (address-geocoder.ts, searchRequestUrl). The public Nominatim forbids
 *   searching as you type and is refused in production (env schema).
 *
 * Never throws, never logs: the URL carries the key. What came back is
 * read the way the deliveries' lookups read it (refusalOf): a 404 with the
 * provider's JSON error is "nothing found", a 429 the day's quota or a
 * burst. A refusal is split in two here, because the text is a person's:
 * a 401/403 or a 404 without the JSON error is about the account or the
 * URL (REFUSED, the search pauses), any other 4xx about the text that was
 * sent (REJECTED, that search alone fails) — anybody typing must not stop
 * every company's search.
 */
type AddressSearchProtocol = "locationiq-autocomplete" | "nominatim-search";

interface AddressSearchProviderConfig {
  url: string;
  protocol: AddressSearchProtocol;
  key: string | undefined;
  keyParam: string;
  userAgent: string;
  timeoutMs: number;
}

interface ProviderSearch {
  /** The text the provider searches, the delivery's city included. */
  text: string;
  /** Where to lean toward; never a filter (`bounded=0`). */
  viewbox: Viewbox | null;
}

/**
 * Asked for, whatever the list shows: the call costs the same, and the
 * ranking has some to reorder and to drop.
 */
const PROVIDER_RESULTS = 10;

/** The refusals about the account or the URL, never about the text. */
const ACCOUNT_REFUSALS: ReadonlySet<number> = new Set([401, 403, 404]);

type ProviderAnswer =
  | { kind: "FOUND"; places: Array<Record<string, unknown>> }
  | { kind: "NOT_FOUND" }
  /** The account or the URL: a key without the product, a wrong path. */
  | { kind: "REFUSED"; status: number }
  /** This text: a 400 (a text too long), a 414. */
  | { kind: "REJECTED"; status: number }
  | { kind: "RATE_LIMITED"; status: 429; scope: "DAY" | "SHORT" }
  | { kind: "FAILED"; status: number | null }
  /** The person typed again (or left): the call was dropped on purpose. */
  | { kind: "ABORTED" };

function providerUrl(
  config: AddressSearchProviderConfig,
  search: ProviderSearch,
): string {
  const viewbox = search.viewbox?.join(",") ?? null;

  if (config.protocol === "nominatim-search") {
    return searchRequestUrl(
      config,
      { q: search.text, viewbox, bounded: viewbox ? "0" : null },
      PROVIDER_RESULTS,
    );
  }

  const url = new URL(`${config.url.replace(/\/+$/, "")}/autocomplete`);

  url.searchParams.set("q", search.text);
  url.searchParams.set("countrycodes", "br");
  url.searchParams.set("limit", String(PROVIDER_RESULTS));
  // `pt` is not among the languages the autocomplete documents; the native
  // names are Portuguese in Brazil.
  url.searchParams.set("accept-language", "native");

  if (viewbox) {
    url.searchParams.set("viewbox", viewbox);
    url.searchParams.set("bounded", "0");
  }

  if (config.key) url.searchParams.set(config.keyParam, config.key);

  return url.toString();
}

/**
 * One call. `signal` is the person's: aborted when they typed again or
 * left, and the call stops there (ABORTED). The provider's own timeout is
 * the config's.
 */
async function searchPlaces(
  config: AddressSearchProviderConfig,
  search: ProviderSearch,
  signal: AbortSignal,
  fetcher: GeocodeFetch = fetch as unknown as GeocodeFetch,
): Promise<ProviderAnswer> {
  const deadline = AbortSignal.timeout(config.timeoutMs);
  const either = AbortSignal.any([deadline, signal]);

  // A body cut short by the timeout or by the person reads as no JSON at
  // all, which must not pass for a page that is not the provider's API.
  const cut = (): ProviderAnswer | null =>
    signal.aborted
      ? { kind: "ABORTED" }
      : deadline.aborted
        ? { kind: "FAILED", status: null }
        : null;

  try {
    const response = await fetcher(providerUrl(config, search), {
      signal: either,
      headers: { "user-agent": config.userAgent, accept: "application/json" },
    });

    if (response.status !== 200) {
      const refusal = await refusalOf(response);

      if (refusal.kind === "REFUSED" && !ACCOUNT_REFUSALS.has(refusal.status)) {
        return cut() ?? { kind: "REJECTED", status: refusal.status };
      }

      // refusalOf answers only these four for a status other than 200.
      return (
        cut() ??
        (refusal.kind === "FOUND" || refusal.kind === "DISABLED"
          ? { kind: "FAILED", status: response.status }
          : refusal)
      );
    }

    const body = await jsonBody(response);
    const stopped = cut();

    if (stopped) return stopped;

    // A 200 that is not a list is a web page or an error object, not the
    // provider's API.
    if (!Array.isArray(body)) return { kind: "REFUSED", status: 200 };

    const places = body.filter(
      (entry): entry is Record<string, unknown> =>
        entry !== null && typeof entry === "object" && !Array.isArray(entry),
    );

    return places.length > 0
      ? { kind: "FOUND", places }
      : { kind: "NOT_FOUND" };
  } catch {
    return cut() ?? { kind: "FAILED", status: null };
  }
}

export { ACCOUNT_REFUSALS, PROVIDER_RESULTS, providerUrl, searchPlaces };
export type {
  AddressSearchProtocol,
  AddressSearchProviderConfig,
  ProviderAnswer,
  ProviderSearch,
};
