import { createHash } from "node:crypto";

import { houseNumber } from "@/shared/services/proof-location/address-geocoder";
import { foldText } from "@/shared/utils/fold-text";

import { LINKING_WORDS, TITLES } from "./geocoding/fallback-agreement";

/**
 * Which deliveries of a company stand at the same door (owner's report of
 * 14/11/2026: a delivery at "Rua Doutor Lipold · Carangola · Petrópolis/RJ"
 * read "Sem localização" while another of the company at the same address
 * had its point). Two addresses with the same key share the point
 * (address-point-reuse.ts); the key never leaves the company — every read
 * filters businessId first.
 *
 * The same, as decision D-22 reads it:
 *
 * - the street, canonical: accents and case folded, the kind spelled out
 *   ("R." is "rua", "Av." is "avenida") and kept — a Rua and an Avenida of
 *   one name are two streets — the titles a dispatcher shortens spelled out
 *   ("Dr." is "doutor", the fallback's list) and the linking words between
 *   two words dropped, never a single letter ("Rua E" is a street);
 * - the house number, compact ("12 A" is "12a"; "12" is not "12A"; "12/14"
 *   is not "1214"), with "s/n", "0" and none all meaning no number
 *   (houseNumber);
 * - the district, the city and the UF: a street of one name in another
 *   district is another street;
 * - never the CEP: it often comes as the city's general one, or wrong.
 *
 * Stored as the SHA-256 of `v1|street|number|district|city|UF`: a fixed size
 * for the index, and no second copy of the address in clear. A change of
 * the rule is a new version, never a silent misread of the old keys.
 *
 * Null without a street, a house number or a city: nothing to tell two
 * doors apart by. Without a number (pre-push review of the batch of
 * 14/11/2026) the street, the district and the city name a street, not a
 * door: every farm on a rural road, every shop on a small town's street
 * with no numbers, every house of a condominium — the km, the lot or the
 * house written in the complement, often under the town's one CEP — would
 * share one key. A dispatcher's pin on one of them, copied as ADDRESS
 * (address-point-reuse.ts), would then send the driver of another to it,
 * and a BLOCK geofence would refuse the proof at the right door. Without a
 * key such a delivery is asked about on its own and pinned on its own, as
 * before the key: a key too strict costs a lookup, one too loose a stop at
 * the wrong door.
 */
interface KeyedAddress {
  street?: string | null;
  address_number?: string | null;
  neighborhood?: string | null;
  city?: string | null;
  uf?: string | null;
}

const ADDRESS_KEY_VERSION = "v1";

/** The kinds of street, each abbreviation to the word it stands for. */
const STREET_KIND: Record<string, string> = {
  r: "rua",
  rua: "rua",
  av: "avenida",
  avda: "avenida",
  avenida: "avenida",
  tv: "travessa",
  trav: "travessa",
  travessa: "travessa",
  al: "alameda",
  alameda: "alameda",
  estr: "estrada",
  est: "estrada",
  estrada: "estrada",
  rod: "rodovia",
  rodovia: "rodovia",
  pca: "praca",
  pc: "praca",
  praca: "praca",
  lgo: "largo",
  largo: "largo",
  beco: "beco",
  viela: "viela",
  ld: "ladeira",
  ladeira: "ladeira",
  servidao: "servidao",
};

/**
 * Whether a word of the name is a linking word the key leaves out: only
 * one that links — another word follows it — and never a single letter.
 * Streets named by a letter are common in planned neighbourhoods, and "e"
 * is also a letter: dropping it made "Rua E" the bare "rua", the key of
 * "Rua", "Rua Da" and "Rua Do" too, so two doors could share a point.
 * Keeping a linking word costs at most a lookup ("Rua João e Maria" is
 * not "Rua João Maria"); dropping one that was a name gives a stop
 * another door's point.
 */
function isDroppedLinkingWord(
  word: string,
  index: number,
  words: readonly string[],
): boolean {
  return word.length > 1 && index < words.length - 1 && LINKING_WORDS.has(word);
}

/** "R. Dr. João da Silva" → "rua doutor joao silva"; "Rua E" → "rua e". */
function canonicalStreet(name: string | null | undefined): string {
  const words = foldText(name).split(" ").filter(Boolean);

  if (words.length === 0) return "";

  // A lone word is a name ("Avenida" in a typo'd row), never a kind.
  const kind = words.length > 1 ? STREET_KIND[words[0]] : undefined;
  const rest = (kind ? words.slice(1) : words).map(
    (word) => TITLES[word] ?? word,
  );

  return [
    ...(kind ? [kind] : []),
    ...rest.filter((word, index) => !isDroppedLinkingWord(word, index, rest)),
  ].join(" ");
}

/**
 * "12 A", "12-a" → "12a"; "1.214" → "1214"; "12/14" → "12-14"; "s/n", "0",
 * "" → "". Two runs of digits keep a mark between them: "12/14" (two doors
 * in one entry) is not door 1214. A dot before three digits is the
 * thousands' one and goes.
 */
function canonicalNumber(value: string | null | undefined): string {
  const number = houseNumber(value);

  if (!number) return "";

  return foldText(number.replace(/(\d)\.(?=\d{3}(?!\d))/g, "$1"))
    .replace(/(\d) (?=\d)/g, "$1-")
    .replace(/ /g, "")
    .replace(/^0+(?=\d)/, "");
}

/** What the key is a hash of; null when it cannot tell doors apart. */
function addressKeyMaterial(address: KeyedAddress): string | null {
  const street = canonicalStreet(address.street);
  const number = canonicalNumber(address.address_number);
  const city = foldText(address.city);

  if (!street || !number || !city) return null;

  return [
    ADDRESS_KEY_VERSION,
    street,
    number,
    foldText(address.neighborhood),
    city,
    (address.uf ?? "").trim().toUpperCase(),
  ].join("|");
}

/**
 * The delivery's address key (SHA-256 hex); null without a street, a house
 * number or a city.
 */
function deliveryAddressKey(address: KeyedAddress): string | null {
  const material = addressKeyMaterial(address);

  return material === null
    ? null
    : createHash("sha256").update(material).digest("hex");
}

export {
  ADDRESS_KEY_VERSION,
  addressKeyMaterial,
  canonicalNumber,
  canonicalStreet,
  deliveryAddressKey,
};
export type { KeyedAddress };
