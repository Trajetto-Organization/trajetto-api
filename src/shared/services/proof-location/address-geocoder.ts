import { calculateDistance } from "@/shared/utils/geolocation";

import {
  isQueryablePoint,
  type GeocodeFetch,
  type ReverseGeocoderConfig,
} from "./reverse-geocoder";

/**
 * The forward lookup of a delivery's address (plan of 02/11/2026, item E1;
 * decision D15): where the customer's door is, for the company's geofence
 * (E2/E4) and the route map. The reverse geocoder's sibling, against the
 * same Nominatim-compatible provider and configuration (REVERSE_GEOCODER_*,
 * LocationIQ in staging and production) — so no new account, no new key.
 *
 * Never awaited by a request: the geocode-deliveries job asks it, and so
 * does the lookup a create, an address edit or a routing starts after its
 * commit (geocode-soon.ts). A spreadsheet of a thousand rows must not wait
 * for a thousand lookups, and no answer waits for the provider.
 *
 * The level matters as much as the point: an answer that only found the
 * district or the city is COARSE, which the job stores without a point (a
 * district's centre is no customer's door) and the geofence never weighs.
 */
type AddressGeocoderConfig = ReverseGeocoderConfig;

type AddressPrecision = "ADDRESS" | "STREET" | "NEIGHBORHOOD" | "CITY";

/** The address columns of a delivery the lookup reads. */
interface GeocodableAddress {
  street: string | null;
  address_number?: string | null;
  neighborhood?: string | null;
  city: string | null;
  uf: string | null;
  cep?: string | null;
}

interface GeocodedPoint {
  latitude: number;
  longitude: number;
  precision: AddressPrecision;
}

/**
 * What a structured answer says about where it is (addressdetails=1), so
 * the fallback can be checked against the delivery before it stands for
 * the address (fallback-agreement.ts).
 */
interface GeocodedPlace {
  /** The street the answer names (`address.road`), as written. */
  road: string | null;

  /** Its district names: suburb, neighbourhood, quarter, city_district. */
  districts: string[];

  /** Its CEP's digits, when OpenStreetMap has one. */
  postcode: string | null;

  /**
   * Another result names the same street more than HOMONYM_DISTANCE_M away:
   * a "Rua São José" in two districts, which street, city and UF alone
   * cannot tell apart.
   */
  repeated: boolean;
}

/**
 * What one lookup came to. Only FOUND and NOT_FOUND are about the ADDRESS;
 * the rest are about the provider, and the job must not charge them to the
 * delivery: a wrong key used to settle every open address as "not found",
 * one batch a minute, for good.
 *
 * - FOUND: a point and its level — and, for the STRUCTURED query, what the
 *   answer says about the place (`place`), to be checked before it stands;
 * - NOT_FOUND: the provider knows no such address — Nominatim's `[]`, or
 *   LocationIQ's 404 with its JSON `error` ("Unable to geocode");
 * - REFUSED: the provider refused the REQUEST — a bad or inactive key (401,
 *   403), a parameter it does not take (400), a URL that is not its API (a
 *   404 without its JSON error, a 200 that is not JSON). Configuration,
 *   which no retry of this address fixes;
 * - RATE_LIMITED: 429 — the day's quota (LocationIQ's "Rate Limited Day")
 *   or a per-second or per-minute burst;
 * - FAILED: no useful answer this time (timeout, network, 5xx, 408), so the
 *   address is tried again later;
 * - DISABLED: no provider configured, nothing was asked.
 *
 * `status` is the HTTP status, for the job's log. Never the URL: it carries
 * the key.
 */
type GeocodeOutcome =
  | ({ kind: "FOUND"; place?: GeocodedPlace } & GeocodedPoint)
  | { kind: "NOT_FOUND" }
  | { kind: "REFUSED"; status: number }
  | { kind: "RATE_LIMITED"; status: 429; scope: "DAY" | "SHORT" }
  | { kind: "FAILED"; status: number | null }
  | { kind: "DISABLED" };

/**
 * The two ways an address is asked (owner's report of 09/11/2026: a full
 * address shown "Sem localização"). FREE_TEXT is the whole address on one
 * line. STRUCTURED is the fallback: only the street, the city and the UF,
 * for when a number, a district or a CEP the map does not know spoiled the
 * first answer. OpenStreetMap's Brazilian CEPs are sparse: a town's general
 * CEP may be on none of its streets.
 */
type GeocodeQuery = "FREE_TEXT" | "STRUCTURED";

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * "Rua Epitácio Pessoa" → "rua epitacio pessoa": no accents, no case, no
 * punctuation, single spaces — how a street or a district typed in the form
 * is compared with the name OpenStreetMap gives it.
 */
function foldText(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * "25610-000", the way an address and OpenStreetMap write a CEP. Every door
 * of ours stores the eight digits ("25610000"), which no map writes; a value
 * that is not eight digits goes as it came.
 */
function formatCep(value: string | null | undefined): string | null {
  const cep = text(value);

  if (!cep) return null;

  const digits = cep.replace(/\D/g, "");

  return digits.length === 8 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : cep;
}

/** "s/n", "S/N", "SN", "sem número", "0": a dispatcher's way of saying none. */
const NO_HOUSE_NUMBER = /^(?:s\/?n|semn[uú]mero|0+)$/;

/** The house number worth asking about; null when it says there is none. */
function houseNumber(value: string | null | undefined): string | null {
  const number = text(value);

  if (!number) return null;

  const compact = number.toLocaleLowerCase("pt-BR").replace(/[\s.°ºª-]/g, "");

  return NO_HOUSE_NUMBER.test(compact) ? null : number;
}

/** "Praça da Sé, 100, Sé, São Paulo - SP, 01001-000, Brasil". */
function addressQuery(address: GeocodableAddress): string {
  const city = text(address.city);
  const uf = text(address.uf);

  return [
    text(address.street),
    houseNumber(address.address_number),
    text(address.neighborhood),
    city && uf ? `${city} - ${uf}` : (city ?? uf),
    formatCep(address.cep),
    "Brasil",
  ]
    .filter(Boolean)
    .join(", ");
}

/**
 * Whether the free-text line carried more than the street, the city and
 * the UF: only then does the structured fallback ask something different,
 * and only then is it worth a call.
 */
function hasFallbackQuery(address: GeocodableAddress): boolean {
  return Boolean(
    houseNumber(address.address_number) ||
    text(address.neighborhood) ||
    formatCep(address.cep),
  );
}

/**
 * How many results the fallback reads: the first answers, the others only
 * say whether the street's name repeats in the city. Nominatim merges the
 * ways of one street (`dedupe`, on by default), and a call costs the same.
 */
const STRUCTURED_RESULTS = 5;

/** /search with the query, the fixed parameters and the key, when there is one. */
function searchRequestUrl(
  config: Pick<AddressGeocoderConfig, "url" | "key" | "keyParam">,
  query: Record<string, string | null>,
  limit = 1,
): string {
  const url = new URL(`${config.url!.replace(/\/+$/, "")}/search`);

  for (const [name, value] of Object.entries(query)) {
    if (value) url.searchParams.set(name, value);
  }

  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("countrycodes", "br");
  url.searchParams.set("accept-language", "pt-BR");

  if (config.key) url.searchParams.set(config.keyParam, config.key);

  return url.toString();
}

/** The request URL, with the key as a query parameter when there is one. */
function searchUrl(
  config: Pick<AddressGeocoderConfig, "url" | "key" | "keyParam">,
  address: GeocodableAddress,
): string {
  return searchRequestUrl(config, { q: addressQuery(address) });
}

/**
 * The fallback: Nominatim's structured search with the street alone (no
 * number), the city and the UF — a shape that found the owner's example on
 * OpenStreetMap as the free text did. LocationIQ's /search takes the same
 * parameters. Five results, not one: the same search also answers other
 * streets of the city (Rua Amazonas and Rua Piauí for Rua Epitácio Pessoa,
 * in Petrópolis), and a street named twice must be seen to be refused.
 */
function structuredSearchUrl(
  config: Pick<AddressGeocoderConfig, "url" | "key" | "keyParam">,
  address: GeocodableAddress,
): string {
  return searchRequestUrl(
    config,
    {
      street: text(address.street),
      city: text(address.city),
      state: text(address.uf),
      country: "Brasil",
    },
    STRUCTURED_RESULTS,
  );
}

const STREET_TYPES = new Set([
  "residential",
  "primary",
  "secondary",
  "tertiary",
  "unclassified",
  "trunk",
  "road",
  "street",
  "service",
  "living_street",
  "pedestrian",
]);

const NEIGHBORHOOD_TYPES = new Set([
  "suburb",
  "neighbourhood",
  "quarter",
  "city_district",
  "borough",
  "hamlet",
]);

/**
 * The level a Nominatim result reached. Nominatim's own place_rank when it
 * sends one (30 a house, 26-27 a street, 18-25 a district); otherwise what
 * the result names (LocationIQ's /search leaves the rank out).
 */
function precisionOf(result: Record<string, unknown>): AddressPrecision {
  const rank = result.place_rank;

  if (typeof rank === "number" && Number.isFinite(rank)) {
    if (rank >= 28) return "ADDRESS";
    if (rank >= 26) return "STREET";
    if (rank >= 18) return "NEIGHBORHOOD";
    return "CITY";
  }

  const address = (result.address ?? {}) as Record<string, unknown>;
  const kind = text(result.type);
  // `jsonv2` names the class `category`; `json` and LocationIQ, `class`.
  const category = text(result.class) ?? text(result.category);

  if (text(address.house_number) || category === "building") return "ADDRESS";

  if (
    category === "highway" ||
    (kind !== null && STREET_TYPES.has(kind)) ||
    text(address.road)
  ) {
    return "STREET";
  }

  if (
    (kind !== null && NEIGHBORHOOD_TYPES.has(kind)) ||
    text(address.suburb) ||
    text(address.neighbourhood) ||
    text(address.quarter)
  ) {
    return "NEIGHBORHOOD";
  }

  return "CITY";
}

/** The first result of a Nominatim `jsonv2` search, or null when unusable. */
function parseNominatimSearch(body: unknown): GeocodedPoint | null {
  if (!Array.isArray(body) || body.length === 0) return null;

  const result = body[0] as Record<string, unknown> | null;

  if (!result || typeof result !== "object") return null;

  const latitude = Number(result.lat);
  const longitude = Number(result.lon);

  if (!isQueryablePoint(latitude, longitude)) return null;

  return { latitude, longitude, precision: precisionOf(result) };
}

/** Two streets of one name at least this far apart are two streets. */
const HOMONYM_DISTANCE_M = 1_000;

const DISTRICT_KEYS = ["suburb", "neighbourhood", "quarter", "city_district"];

/** What a result's `address` says about where it is. */
function placeOf(
  result: Record<string, unknown>,
): Omit<GeocodedPlace, "repeated"> {
  const address = (result.address ?? {}) as Record<string, unknown>;
  const postcode = text(address.postcode)?.replace(/\D/g, "") ?? "";

  return {
    road: text(address.road),
    districts: DISTRICT_KEYS.map((key) => text(address[key])).filter(
      (name): name is string => name !== null,
    ),
    postcode: postcode || null,
  };
}

/**
 * The structured search's answer: the first result, with what it says
 * about its place, and whether another of the results names the same
 * street far from it.
 */
function parseStructuredSearch(
  body: unknown,
): (GeocodedPoint & { place: GeocodedPlace }) | null {
  const point = parseNominatimSearch(body);

  if (!point || !Array.isArray(body)) return null;

  const results = body.filter(
    (entry): entry is Record<string, unknown> =>
      entry !== null && typeof entry === "object",
  );
  const place = placeOf(results[0]);
  const road = foldText(place.road);

  const repeated =
    road !== "" &&
    results.slice(1).some((other) => {
      const latitude = Number(other.lat);
      const longitude = Number(other.lon);

      return (
        foldText(placeOf(other).road) === road &&
        isQueryablePoint(latitude, longitude) &&
        calculateDistance(
          point.latitude,
          point.longitude,
          latitude,
          longitude,
        ) > HOMONYM_DISTANCE_M
      );
    });

  return { ...point, place: { ...place, repeated } };
}

/** The body as JSON, or undefined when it is not JSON (an HTML error page). */
async function jsonBody(response: {
  json(): Promise<unknown>;
}): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/** A Nominatim-compatible error body's `error` text, or null. */
function errorText(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;

  return text((body as { error?: unknown }).error);
}

/**
 * What an answer other than 200 means (see GeocodeOutcome). 408 is the one
 * 4xx that is about this moment, not the request.
 */
async function refusalOf(response: {
  status: number;
  json(): Promise<unknown>;
}): Promise<GeocodeOutcome> {
  const { status } = response;

  // LocationIQ answers "Unable to geocode" as a 404 with its JSON error. A
  // 404 without one is a path that is not the provider's API — a
  // REVERSE_GEOCODER_URL off by a segment — and must not read as an address
  // nobody knows.
  if (status === 404) {
    return errorText(await jsonBody(response)) !== null
      ? { kind: "NOT_FOUND" }
      : { kind: "REFUSED", status };
  }

  if (status === 429) {
    const reason = errorText(await jsonBody(response)) ?? "";

    return {
      kind: "RATE_LIMITED",
      status,
      scope: /day/i.test(reason) ? "DAY" : "SHORT",
    };
  }

  if (status >= 400 && status < 500 && status !== 408) {
    return { kind: "REFUSED", status };
  }

  return { kind: "FAILED", status };
}

/**
 * One lookup, in the shape asked. Never throws; the URL carries the key, so
 * it is never logged. An address without a street or a city is not worth a
 * call: NOT_FOUND.
 */
async function geocodeAddress(
  address: GeocodableAddress,
  config: AddressGeocoderConfig,
  fetcher: GeocodeFetch = fetch as unknown as GeocodeFetch,
  query: GeocodeQuery = "FREE_TEXT",
): Promise<GeocodeOutcome> {
  if (!config.url) return { kind: "DISABLED" };

  if (!text(address.street) || !text(address.city)) {
    return { kind: "NOT_FOUND" };
  }

  const url =
    query === "STRUCTURED"
      ? structuredSearchUrl(config, address)
      : searchUrl(config, address);

  try {
    const response = await fetcher(url, {
      signal: AbortSignal.timeout(config.timeoutMs),
      headers: { "user-agent": config.userAgent, accept: "application/json" },
    });

    if (response.status !== 200) return await refusalOf(response);

    const body = await jsonBody(response);

    // A 200 that is not JSON is a web page, not a Nominatim-compatible API.
    if (body === undefined) return { kind: "REFUSED", status: 200 };

    const point =
      query === "STRUCTURED"
        ? parseStructuredSearch(body)
        : parseNominatimSearch(body);

    return point ? { kind: "FOUND", ...point } : { kind: "NOT_FOUND" };
  } catch {
    return { kind: "FAILED", status: null };
  }
}

export {
  HOMONYM_DISTANCE_M,
  addressQuery,
  foldText,
  formatCep,
  geocodeAddress,
  hasFallbackQuery,
  houseNumber,
  parseNominatimSearch,
  parseStructuredSearch,
  precisionOf,
  searchUrl,
  structuredSearchUrl,
};
export type {
  AddressGeocoderConfig,
  AddressPrecision,
  GeocodableAddress,
  GeocodeOutcome,
  GeocodeQuery,
  GeocodedPlace,
  GeocodedPoint,
};
