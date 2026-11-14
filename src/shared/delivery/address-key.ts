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
 *   ("Dr." is "doutor", the fallback's list) and the linking words dropped;
 * - the house number, compact ("12 A" is "12a"; "12" is not "12A"), with
 *   "s/n", "0" and none all meaning no number (houseNumber);
 * - the district, the city and the UF: a street of one name in another
 *   district is another street;
 * - never the CEP: it often comes as the city's general one, or wrong.
 *
 * Stored as the SHA-256 of `v1|street|number|district|city|UF`: a fixed size
 * for the index, and no second copy of the address in clear. A change of
 * the rule is a new version, never a silent misread of the old keys.
 * Null without a street or a city: nothing to tell two doors apart by.
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

/** "R. Dr. João da Silva" → "rua doutor joao silva". */
function canonicalStreet(name: string | null | undefined): string {
  const words = foldText(name).split(" ").filter(Boolean);

  if (words.length === 0) return "";

  // A lone word is a name ("Avenida" in a typo'd row), never a kind.
  const kind = words.length > 1 ? STREET_KIND[words[0]] : undefined;
  const rest = kind ? words.slice(1) : words;

  return [
    ...(kind ? [kind] : []),
    ...rest
      .map((word) => TITLES[word] ?? word)
      .filter((word) => !LINKING_WORDS.has(word)),
  ].join(" ");
}

/** "12 A", "12-a" → "12a"; "s/n", "0", "" → "". */
function canonicalNumber(value: string | null | undefined): string {
  const number = houseNumber(value);

  if (!number) return "";

  return foldText(number)
    .replace(/ /g, "")
    .replace(/^0+(?=\d)/, "");
}

/** What the key is a hash of; null when it cannot tell doors apart. */
function addressKeyMaterial(address: KeyedAddress): string | null {
  const street = canonicalStreet(address.street);
  const city = foldText(address.city);

  if (!street || !city) return null;

  return [
    ADDRESS_KEY_VERSION,
    street,
    canonicalNumber(address.address_number),
    foldText(address.neighborhood),
    city,
    (address.uf ?? "").trim().toUpperCase(),
  ].join("|");
}

/** The delivery's address key (SHA-256 hex); null without street or city. */
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
