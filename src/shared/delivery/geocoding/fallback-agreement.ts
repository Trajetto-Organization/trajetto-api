import { calculateDistance } from "@/shared/utils/geolocation";
import {
  foldText,
  type GeocodableAddress,
  type GeocodeOutcome,
} from "@/shared/services/proof-location/address-geocoder";

/**
 * Whether the fallback's answer may stand for the delivery's address
 * (review of 09/11/2026). The fallback asks street, city and UF alone, so
 * it drops exactly what told two streets of one name apart: the district,
 * the CEP and the number. A "Rua São José" found in the wrong district is
 * worse than none — a point the company's geofence measures from, which in
 * BLOCK refuses the driver at the right door. So a point from the fallback
 * stands only when nothing contradicts it:
 *
 * - it is the street asked (the same search also answers other streets of
 *   the city: Rua Amazonas for Rua Epitácio Pessoa, in Petrópolis);
 * - the city has no other street of that name far from it (`repeated`);
 * - the district it names, when it names one, is the delivery's;
 * - its CEP, when OpenStreetMap has one, shares the delivery's first five
 *   digits — unless the delivery's ends in -000, a town's or a district's
 *   general CEP, which says no more than the city;
 * - when the full address reached a district, it lies within
 *   DISTRICT_RADIUS_M of it.
 *
 * Anything else keeps the full address's own answer: no point, as before
 * the fallback ("Endereço não localizado — fixe no mapa"). An answer
 * without a point (a district, a city) is never worse than none and is not
 * checked.
 */

/** How far from the district the full address reached a street may lie. */
const DISTRICT_RADIUS_M = 3_000;

/** The words that name the kind of street, not the street. */
const STREET_KINDS = new Set([
  "rua",
  "r",
  "avenida",
  "av",
  "avda",
  "travessa",
  "tv",
  "trav",
  "alameda",
  "al",
  "estrada",
  "estr",
  "est",
  "rodovia",
  "rod",
  "praca",
  "pca",
  "pc",
  "largo",
  "lgo",
  "beco",
  "viela",
  "ladeira",
  "ld",
  "servidao",
]);

/** The titles a dispatcher shortens and OpenStreetMap spells out. */
const TITLES: Record<string, string> = {
  dr: "doutor",
  dra: "doutora",
  prof: "professor",
  profa: "professora",
  pres: "presidente",
  gov: "governador",
  sen: "senador",
  dep: "deputado",
  eng: "engenheiro",
  cel: "coronel",
  gen: "general",
  mal: "marechal",
  cap: "capitao",
  ten: "tenente",
  pe: "padre",
  sta: "santa",
  sto: "santo",
};

const LINKING_WORDS = new Set(["de", "da", "do", "das", "dos", "e"]);

/** "R. Dr. João da Silva" → ["doutor", "joao", "silva"]. */
function streetWords(name: string | null | undefined): string[] {
  const words = foldText(name).split(" ").filter(Boolean);

  if (words.length > 1 && STREET_KINDS.has(words[0])) words.shift();

  return words
    .map((word) => TITLES[word] ?? word)
    .filter((word) => !LINKING_WORDS.has(word));
}

/** Whether `part` appears in `whole` as consecutive words. */
function containsWords(whole: string[], part: string[]): boolean {
  return ` ${whole.join(" ")} `.includes(` ${part.join(" ")} `);
}

/**
 * The same street: the same words, or — two words at least — one name
 * inside the other ("Rua João Pessoa" in "Rua Presidente João Pessoa").
 */
function sameStreet(
  asked: string | null | undefined,
  found: string | null | undefined,
): boolean {
  const a = streetWords(asked);
  const b = streetWords(found);

  if (a.length === 0 || b.length === 0) return false;

  if (a.join(" ") === b.join(" ")) return true;

  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];

  return shorter.length >= 2 && containsWords(longer, shorter);
}

/** The delivery's district among the answer's, when both have one. */
function districtAgrees(
  neighborhood: string | null | undefined,
  districts: readonly string[],
): boolean {
  const asked = foldText(neighborhood).split(" ").filter(Boolean);

  if (asked.length === 0 || districts.length === 0) return true;

  return districts.some((district) => {
    const found = foldText(district).split(" ").filter(Boolean);

    return (
      found.length > 0 &&
      (containsWords(found, asked) || containsWords(asked, found))
    );
  });
}

/** The first five digits of the CEP agree, when both have them. */
function postcodeAgrees(
  cep: string | null | undefined,
  postcode: string | null,
): boolean {
  const asked = (cep ?? "").replace(/\D/g, "");

  if (asked.length !== 8 || asked.endsWith("000")) return true;

  if (!postcode || postcode.length < 5) return true;

  return asked.slice(0, 5) === postcode.slice(0, 5);
}

function fallbackAgrees(
  address: GeocodableAddress,
  first: GeocodeOutcome,
  second: GeocodeOutcome,
): boolean {
  if (second.kind !== "FOUND") return true;

  if (second.precision !== "ADDRESS" && second.precision !== "STREET") {
    return true;
  }

  const { place } = second;

  if (!place) return false;

  if (!sameStreet(address.street, place.road) || place.repeated) return false;

  if (!districtAgrees(address.neighborhood, place.districts)) return false;

  if (!postcodeAgrees(address.cep, place.postcode)) return false;

  if (first.kind === "FOUND" && first.precision === "NEIGHBORHOOD") {
    return (
      calculateDistance(
        first.latitude,
        first.longitude,
        second.latitude,
        second.longitude,
      ) <= DISTRICT_RADIUS_M
    );
  }

  return true;
}

export {
  DISTRICT_RADIUS_M,
  districtAgrees,
  fallbackAgrees,
  postcodeAgrees,
  sameStreet,
};
