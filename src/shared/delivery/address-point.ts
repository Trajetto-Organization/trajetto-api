/**
 * The point on the route map belongs to the ADDRESS (decision 14.7, design
 * §4.11). It is pinned by the dispatcher ("Fixar no mapa") or, later, found
 * by a geocoder; either way it is about one street and number. An edit that
 * moves the address leaves the old pin pointing where the delivery no longer
 * is, so the point is cleared and the stop goes back to "sem localização".
 */
const ADDRESS_FIELDS = [
  "street",
  "address_number",
  "neighborhood",
  "city",
  "uf",
  "cep",
] as const;

type AddressFields = Partial<
  Record<(typeof ADDRESS_FIELDS)[number], string | null>
>;

function normalized(value: string | null | undefined): string {
  return (value ?? "").trim().toLocaleLowerCase("pt-BR");
}

/**
 * Whether an edit changes the address. A field left out (undefined) keeps
 * its value; one sent with the same text — case and surrounding spaces
 * aside — is not a change.
 */
function addressChanged(current: AddressFields, next: AddressFields): boolean {
  return ADDRESS_FIELDS.some(
    (field) =>
      next[field] !== undefined &&
      normalized(next[field]) !== normalized(current[field]),
  );
}

/**
 * The address after an edit: what the edit sends, and the stored value for
 * a field it leaves out — the address the new address key is computed from
 * (address-key.ts), so the edit can take the point another delivery of the
 * company already has there.
 */
function editedAddress(
  current: AddressFields,
  next: AddressFields,
): AddressFields {
  return Object.fromEntries(
    ADDRESS_FIELDS.map((field) => [
      field,
      next[field] !== undefined ? next[field] : (current[field] ?? null),
    ]),
  ) as AddressFields;
}

/**
 * The columns an address change clears: the point, and the geocoder's
 * bookkeeping with it (plan of 02/11/2026, E1), so the new address is
 * geocoded again — and a lookup of the old one still in flight finds its
 * claim gone and writes nothing.
 */
const CLEARED_ADDRESS_POINT = {
  latitude: null,
  longitude: null,
  geo_source: null,
  geo_updated_at: null,
  geo_precision: null,
  geocode_status: null,
  geocode_attempted_at: null,
  geocode_attempts: 0,
} as const;

export { ADDRESS_FIELDS, CLEARED_ADDRESS_POINT, addressChanged, editedAddress };
export type { AddressFields };
