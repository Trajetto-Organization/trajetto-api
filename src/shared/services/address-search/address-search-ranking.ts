import {
  ADDRESS_SEARCH_MAX_QUERY,
  type Viewbox,
} from "@/modules/address-search/schemas/address-search-schemas";
import { UF_NAMES, ufOf, type Uf } from "@/shared/brazil/uf-names";
import { isInsideBrazil } from "@/shared/delivery/address-coordinates";
import {
  formatCep,
  precisionOf,
} from "@/shared/services/proof-location/address-geocoder";
import { isQueryablePoint } from "@/shared/services/proof-location/reverse-geocoder";
import { foldText } from "@/shared/utils/fold-text";
import { calculateDistance } from "@/shared/utils/geolocation";

/**
 * The provider's places as the list of the route page shows them (plan
 * pin-search): Brazilian only, each once, with a title and a subtitle in
 * the shape the panel writes an address, the level the point reached, and
 * the delivery's city first. Pure: the provider (address-search-provider)
 * and the cache (address-search-limits) live elsewhere.
 *
 * The level matters as it does for the deliveries' lookups: a district or a
 * city is no customer's door, so the web frames those on the map and asks
 * for the click instead of placing the pin. PLACE is the one level the
 * geocoder does not have: a named place (a hospital, a shop, a school)
 * whose point is the place itself.
 */
type SuggestionPrecision =
  "ADDRESS" | "STREET" | "PLACE" | "NEIGHBORHOOD" | "CITY";

interface AddressSuggestion {
  /** The provider's place id; stable for a place across searches. */
  id: string;
  /** "Rua Epitácio Pessoa, 120" or "Hospital Santa Teresa". */
  title: string;
  /** "Centro, Petrópolis - RJ, 25610-000". */
  subtitle: string;
  latitude: number;
  longitude: number;
  precision: SuggestionPrecision;
  city: string | null;
  uf: Uf | null;
  /**
   * South, north, west, east: the area a district or a city covers, for
   * the map to frame. Null for a point-sized result.
   */
  bbox: [number, number, number, number] | null;
  /** In the city and UF searched in; false when no city was given. */
  inScope: boolean;
}

/** The delivery's city, when the search is scoped to it. */
interface SearchHint {
  city: string;
  uf: Uf;
}

interface RankedSearch {
  results: AddressSuggestion[];
  /**
   * Nothing in the results bears a name that was typed: the provider found
   * nothing by that name and answered something else ("Curitba", a typo,
   * came back as a street in Boa Vista). The list must not preselect any.
   */
  weak: boolean;
}

/** Words that say what kind of place it is, not which one. */
const GENERIC_WORDS = new Set([
  "rua",
  "avenida",
  "av",
  "travessa",
  "alameda",
  "estrada",
  "rodovia",
  "praca",
  "largo",
  "bairro",
  "cidade",
  "dos",
  "das",
  "para",
]);

/** The OpenStreetMap classes of a named place whose point is the place. */
const PLACE_CLASSES = new Set([
  "amenity",
  "shop",
  "tourism",
  "office",
  "leisure",
  "healthcare",
  "craft",
  "historic",
  "building",
]);

/** Two results of one title closer than this are one place. */
const SAME_PLACE_M = 30;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** The names typed that can tell one place from another. */
function nameTokens(query: string): string[] {
  return foldText(query)
    .split(" ")
    .filter(
      (token) =>
        token.length >= 3 && !/^\d+$/.test(token) && !GENERIC_WORDS.has(token),
    );
}

/** The numbers typed: a house number, when one is there. */
function numberTokens(query: string): string[] {
  return foldText(query)
    .split(" ")
    .filter((token) => /^\d+$/.test(token));
}

/**
 * The text the provider searches: what was typed, then the delivery's city
 * and state — unless the city is already in it. A street name repeats from
 * city to city ("Rua São José"), and a viewbox only leans.
 *
 * Never past the provider's 200 characters, which only `q` is checked
 * against: a long text with the city's chip answered 400. The state goes
 * first, then the city; the ranking still puts the city's places first.
 */
function scopedText(query: string, hint: SearchHint | null): string {
  if (!hint) return query;

  const city = foldText(hint.city);

  if (city && ` ${foldText(query)} `.includes(` ${city} `)) return query;

  return (
    [
      `${query}, ${hint.city}, ${UF_NAMES[hint.uf]}`,
      `${query}, ${hint.city}`,
    ].find((text) => text.length <= ADDRESS_SEARCH_MAX_QUERY) ?? query
  );
}

interface Candidate extends AddressSuggestion {
  order: number;
  road: string | null;
  name: string | null;
  house: string | null;
}

/** The [south, north, west, east] of a coarse result, when it makes sense. */
function bboxOf(place: Record<string, unknown>): Candidate["bbox"] {
  const raw = place.boundingbox;

  if (!Array.isArray(raw) || raw.length !== 4) return null;

  const [south, north, west, east] = raw.map(Number);

  const valid =
    [south, north, west, east].every(Number.isFinite) &&
    south <= north &&
    west <= east &&
    south >= -90 &&
    north <= 90 &&
    west >= -180 &&
    east <= 180;

  return valid ? [south, north, west, east] : null;
}

function candidateOf(
  place: Record<string, unknown>,
  order: number,
  hint: SearchHint | null,
): Candidate | null {
  const latitude = Number(place.lat);
  const longitude = Number(place.lon);

  if (
    !isQueryablePoint(latitude, longitude) ||
    !isInsideBrazil({ latitude, longitude })
  ) {
    return null;
  }

  const address = (
    place.address && typeof place.address === "object" ? place.address : {}
  ) as Record<string, unknown>;

  const country = text(address.country_code)?.toLowerCase();

  if (country && country !== "br") return null;

  const road =
    text(address.road) ?? text(address.pedestrian) ?? text(address.footway);
  const house = text(address.house_number);
  // jsonv2 names the object `name`; LocationIQ's autocomplete puts it in
  // `address.name` and `display_place`.
  const name =
    text(place.name) ?? text(address.name) ?? text(place.display_place);
  const district =
    text(address.suburb) ??
    text(address.neighbourhood) ??
    text(address.quarter) ??
    text(address.city_district);
  const city =
    text(address.city) ??
    text(address.town) ??
    text(address.village) ??
    text(address.municipality);
  const uf =
    ufOf(text(address.state_code)) ??
    ufOf(text(address["ISO3166-2-lvl4"])) ??
    ufOf(text(address.state));
  const cep = formatCep(text(address.postcode));

  const category = text(place.class) ?? text(place.category);
  const named = name !== null && foldText(name) !== foldText(road);

  const precision: SuggestionPrecision =
    category !== null && PLACE_CLASSES.has(category) && named
      ? "PLACE"
      : precisionOf(place);

  const street = road ? (house ? `${road}, ${house}` : road) : null;
  const first = text(text(place.display_name)?.split(",")[0]);

  const title =
    (precision === "PLACE"
      ? name
      : precision === "ADDRESS" || precision === "STREET"
        ? (street ?? name)
        : precision === "NEIGHBORHOOD"
          ? (district ?? name)
          : (city ?? name)) ??
    first ??
    "Local sem nome";

  const folded = foldText(title);
  const cityLine =
    city && foldText(city) === folded
      ? uf
        ? UF_NAMES[uf]
        : null
      : city && uf
        ? `${city} - ${uf}`
        : (city ?? (uf ? UF_NAMES[uf] : null));

  const subtitle =
    [
      precision === "PLACE" ? street : null,
      district && foldText(district) !== folded ? district : null,
      cityLine,
      cep,
    ]
      .filter((part): part is string => Boolean(part))
      .join(", ") || "Brasil";

  const coarse = precision === "NEIGHBORHOOD" || precision === "CITY";

  return {
    id: String(
      place.place_id ??
        (place.osm_type && place.osm_id
          ? `${String(place.osm_type)}${String(place.osm_id)}`
          : `${latitude},${longitude}`),
    ),
    title,
    subtitle,
    latitude,
    longitude,
    precision,
    city,
    uf,
    bbox: coarse ? bboxOf(place) : null,
    inScope:
      hint !== null &&
      city !== null &&
      foldText(city) === foldText(hint.city) &&
      (uf === null || uf === hint.uf),
    order,
    road,
    name,
    house,
  };
}

/** What leaves the API: the candidate without the ranking's own fields. */
function suggestionOf(candidate: Candidate): AddressSuggestion {
  return {
    id: candidate.id,
    title: candidate.title,
    subtitle: candidate.subtitle,
    latitude: candidate.latitude,
    longitude: candidate.longitude,
    precision: candidate.precision,
    city: candidate.city,
    uf: candidate.uf,
    bbox: candidate.bbox,
    inScope: candidate.inScope,
  };
}

/** Points for how well a candidate answers what was typed, and where. */
function scoreOf(
  candidate: Candidate,
  hint: SearchHint | null,
  tokens: string[],
  numbers: string[],
): number {
  let score = 0;

  if (hint) {
    if (
      candidate.city !== null &&
      foldText(candidate.city) === foldText(hint.city)
    ) {
      score += 4;
    }

    if (candidate.uf === hint.uf) score += 1;
  }

  const house = candidate.house?.replace(/\D/g, "") ?? "";

  if (house && numbers.includes(house)) score += 2;

  const named = `${foldText(candidate.road)} ${foldText(candidate.name)}`;

  if (tokens.some((token) => named.includes(token))) score += 1;

  if (candidate.precision === "NEIGHBORHOOD") score -= 1;
  if (candidate.precision === "CITY") score -= 2;

  return score;
}

function centreOf(viewbox: Viewbox | null): [number, number] | null {
  if (!viewbox) return null;

  const [west, south, east, north] = viewbox;

  return [(south + north) / 2, (west + east) / 2];
}

/**
 * The places to show, best first: the delivery's city, then its UF, the
 * number typed, a name typed; a district or a city after the doors. Ties
 * go to the one nearer the route's stops, then to the provider's order.
 */
function rankSuggestions(
  places: ReadonlyArray<Record<string, unknown>>,
  {
    query,
    hint,
    viewbox,
    limit,
  }: {
    query: string;
    hint: SearchHint | null;
    viewbox: Viewbox | null;
    limit: number;
  },
): RankedSearch {
  const tokens = nameTokens(query);
  const numbers = numberTokens(query);
  const centre = centreOf(viewbox);

  const candidates = places
    .map((place, index) => candidateOf(place, index, hint))
    .filter((candidate): candidate is Candidate => candidate !== null)
    .map((candidate) => ({
      candidate,
      score: scoreOf(candidate, hint, tokens, numbers),
      distance: centre
        ? calculateDistance(
            centre[0],
            centre[1],
            candidate.latitude,
            candidate.longitude,
          )
        : 0,
    }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.distance - right.distance ||
        left.candidate.order - right.candidate.order,
    )
    .map(({ candidate }) => candidate);

  const kept: Candidate[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const title = foldText(candidate.title);
    const key = `${title}|${foldText(candidate.city)}`;

    const near = kept.some(
      (other) =>
        foldText(other.title) === title &&
        calculateDistance(
          other.latitude,
          other.longitude,
          candidate.latitude,
          candidate.longitude,
        ) < SAME_PLACE_M,
    );

    if (seen.has(key) || near) continue;

    seen.add(key);
    kept.push(candidate);
  }

  const results = kept.slice(0, limit).map(suggestionOf);

  const weak =
    results.length > 0 &&
    tokens.length > 0 &&
    !results.some((result) => {
      const shown = foldText(`${result.title} ${result.subtitle}`);

      return tokens.some((token) => shown.includes(token));
    });

  return { results, weak };
}

export { nameTokens, rankSuggestions, scopedText };
export type {
  AddressSuggestion,
  RankedSearch,
  SearchHint,
  SuggestionPrecision,
};
