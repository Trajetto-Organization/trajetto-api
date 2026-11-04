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
 * Called only by the geocode-deliveries job, never by a request: a
 * spreadsheet of a thousand rows must not wait for a thousand lookups.
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
 * FOUND: a point and its level. NOT_FOUND: the provider knows no such
 * address (settled until the address changes). FAILED: the provider did not
 * answer usefully (timeout, refusal, 429, 5xx) — try again later.
 * DISABLED: no provider configured, nothing was asked.
 */
type GeocodeOutcome =
  | ({ kind: "FOUND" } & GeocodedPoint)
  | { kind: "NOT_FOUND" }
  | { kind: "FAILED"; status: number | null }
  | { kind: "DISABLED" };

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** "Praça da Sé, 100, Sé, São Paulo - SP, 01001-000, Brasil". */
function addressQuery(address: GeocodableAddress): string {
  const city = text(address.city);
  const uf = text(address.uf);

  return [
    text(address.street),
    text(address.address_number),
    text(address.neighborhood),
    city && uf ? `${city} - ${uf}` : (city ?? uf),
    text(address.cep),
    "Brasil",
  ]
    .filter(Boolean)
    .join(", ");
}

/** The request URL, with the key as a query parameter when there is one. */
function searchUrl(
  config: Pick<AddressGeocoderConfig, "url" | "key" | "keyParam">,
  address: GeocodableAddress,
): string {
  const url = new URL(`${config.url!.replace(/\/+$/, "")}/search`);

  url.searchParams.set("q", addressQuery(address));
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("limit", "1");
  url.searchParams.set("countrycodes", "br");
  url.searchParams.set("accept-language", "pt-BR");

  if (config.key) url.searchParams.set(config.keyParam, config.key);

  return url.toString();
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
  const category = text(result.class);

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

/**
 * One lookup. Never throws; the URL carries the key, so it is never logged.
 * An address without a street or a city is not worth a call: NOT_FOUND.
 */
async function geocodeAddress(
  address: GeocodableAddress,
  config: AddressGeocoderConfig,
  fetcher: GeocodeFetch = fetch as unknown as GeocodeFetch,
): Promise<GeocodeOutcome> {
  if (!config.url) return { kind: "DISABLED" };

  if (!text(address.street) || !text(address.city)) {
    return { kind: "NOT_FOUND" };
  }

  try {
    const response = await fetcher(searchUrl(config, address), {
      signal: AbortSignal.timeout(config.timeoutMs),
      headers: { "user-agent": config.userAgent, accept: "application/json" },
    });

    // LocationIQ answers "Unable to geocode" as a 404; Nominatim as [].
    if (response.status === 404) return { kind: "NOT_FOUND" };

    if (response.status !== 200) {
      return { kind: "FAILED", status: response.status };
    }

    const point = parseNominatimSearch(await response.json());

    return point ? { kind: "FOUND", ...point } : { kind: "NOT_FOUND" };
  } catch {
    return { kind: "FAILED", status: null };
  }
}

export {
  addressQuery,
  geocodeAddress,
  parseNominatimSearch,
  precisionOf,
  searchUrl,
};
export type {
  AddressGeocoderConfig,
  AddressPrecision,
  GeocodableAddress,
  GeocodeOutcome,
  GeocodedPoint,
};
