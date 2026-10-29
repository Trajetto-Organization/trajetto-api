import type { GpsAddress } from "@/shared/delivery/proof-document";

/**
 * Reverse geocoding for the proof document's "GPS coletado" block (decision
 * 14.8, design §5.1): the address the GPS fix points at, as opposed to the
 * address the delivery was registered with. The two disagreeing is precisely
 * what the block is there to show.
 *
 * Nominatim protocol, so the provider can be our own Nominatim container or
 * a commercial Nominatim-compatible API. The public nominatim.openstreetmap.org
 * forbids this volume and is refused outside development by the env schema.
 */
interface ReverseGeocoderConfig {
  /** Base URL; empty means switched off. */
  url: string | undefined;
  key: string | undefined;
  keyParam: string;
  userAgent: string;
  timeoutMs: number;
}

type GeocodeFetch = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<{ status: number; json(): Promise<unknown> }>;

/** Coordinates worth asking about: inside the globe and not the (0,0) of a missing fix. */
function isQueryablePoint(latitude: number, longitude: number): boolean {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180 &&
    !(latitude === 0 && longitude === 0)
  );
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * A Nominatim `jsonv2` answer as the address the PDF prints. Null when it has
 * nothing usable (an error object, or no address at all). A country other
 * than Brazil is kept as it came: it is evidence, not ours to correct.
 */
function parseNominatimAddress(body: unknown): GpsAddress | null {
  if (!body || typeof body !== "object") return null;

  const address = (body as { address?: Record<string, unknown> }).address;

  if (!address || typeof address !== "object") return null;

  const road =
    text(address.road) ?? text(address.pedestrian) ?? text(address.footway);
  const number = text(address.house_number);

  const result: GpsAddress = {
    line: road ? (number ? `${road}, ${number}` : road) : null,
    district:
      text(address.suburb) ??
      text(address.neighbourhood) ??
      text(address.quarter) ??
      text(address.city_district),
    city:
      text(address.city) ??
      text(address.town) ??
      text(address.village) ??
      text(address.municipality),
    state: text(address.state),
    cep: text(address.postcode),
  };

  return result.line || result.district || result.city ? result : null;
}

/** The request URL, with the key as a query parameter when there is one. */
function reverseUrl(
  config: Pick<ReverseGeocoderConfig, "url" | "key" | "keyParam">,
  latitude: number,
  longitude: number,
): string {
  const url = new URL(`${config.url!.replace(/\/+$/, "")}/reverse`);

  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("lat", String(latitude));
  url.searchParams.set("lon", String(longitude));
  url.searchParams.set("zoom", "18");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("accept-language", "pt-BR");

  if (config.key) url.searchParams.set(config.keyParam, config.key);

  return url.toString();
}

/**
 * One reverse lookup. Null on any failure — timeout, HTTP error, unusable
 * answer — and never throws: the PDF has a labelled fallback for this.
 * The URL carries the key, so it is never logged.
 */
async function reverseGeocode(
  latitude: number,
  longitude: number,
  config: ReverseGeocoderConfig,
  fetcher: GeocodeFetch = fetch as unknown as GeocodeFetch,
): Promise<GpsAddress | null> {
  if (!config.url || !isQueryablePoint(latitude, longitude)) return null;

  try {
    const response = await fetcher(reverseUrl(config, latitude, longitude), {
      signal: AbortSignal.timeout(config.timeoutMs),
      headers: { "user-agent": config.userAgent, accept: "application/json" },
    });

    if (response.status !== 200) return null;

    return parseNominatimAddress(await response.json());
  } catch {
    return null;
  }
}

/**
 * At most `limit` lookups in flight per replica. Past it the caller renders
 * with the fallback WITHOUT caching "unavailable", so the next request tries
 * again (design §5.1).
 */
class Semaphore {
  private inFlight = 0;

  constructor(private readonly limit: number) {}

  tryAcquire(): (() => void) | null {
    if (this.inFlight >= this.limit) return null;

    this.inFlight += 1;

    let released = false;

    return () => {
      if (released) return;
      released = true;
      this.inFlight -= 1;
    };
  }
}

export {
  Semaphore,
  isQueryablePoint,
  parseNominatimAddress,
  reverseGeocode,
  reverseUrl,
};
export type { GeocodeFetch, ReverseGeocoderConfig };
