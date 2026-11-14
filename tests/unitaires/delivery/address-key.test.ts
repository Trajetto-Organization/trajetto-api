import { describe, expect, it } from "vitest";

import {
  addressKeyMaterial,
  canonicalNumber,
  canonicalStreet,
  deliveryAddressKey,
} from "@/shared/delivery/address-key";

/**
 * Which deliveries of a company stand at the same door (owner's report of
 * 14/11/2026; decision D-22): a delivery at "Rua Doutor Lipold · Carangola
 * · Petrópolis/RJ" read "Sem localização" while another of the company at
 * the same address had its point. The key is what tells "the same address"
 * apart from a neighbour's: two keys equal share the point, so a key too
 * loose puts a stop at the wrong door, and one too strict only costs a
 * lookup.
 */
const LIPOLD = {
  street: "Rua Doutor Lipold",
  address_number: "10",
  neighborhood: "Carangola",
  city: "Petrópolis",
  uf: "RJ",
  cep: "25715-000",
};

const key = (
  overrides: Partial<Record<keyof typeof LIPOLD, string | null>> = {},
) => deliveryAddressKey({ ...LIPOLD, ...overrides });

describe("the same door", () => {
  it("is the owner's address however a dispatcher, a note or a sheet spells it", () => {
    const expected = deliveryAddressKey(LIPOLD);

    expect(expected).toMatch(/^[0-9a-f]{64}$/);
    for (const street of [
      "R. Dr. Lipold",
      "R DR LIPOLD",
      "rua doutor lipold",
      "  Rua   Doutor   Lipold ",
    ]) {
      expect(key({ street }), street).toBe(expected);
    }

    // Accents and case in the district and the city, the UF's case.
    expect(
      key({ neighborhood: "CARANGOLA", city: "Petropolis", uf: "rj" }),
    ).toBe(expected);
  });

  it("drops the linking words and spells out the titles", () => {
    expect(canonicalStreet("Av. Pres. Getúlio Vargas")).toBe(
      "avenida presidente getulio vargas",
    );
    expect(canonicalStreet("Rua da Paz")).toBe(canonicalStreet("R. de Paz"));
    expect(canonicalStreet("Tv. Sta. Luzia")).toBe("travessa santa luzia");
  });

  it("reads 's/n', '0' and no number as the same: no number", () => {
    const none = key({ address_number: "" });

    for (const address_number of [
      "s/n",
      "S/N",
      "SN",
      "0",
      null,
      "sem número",
    ]) {
      expect(key({ address_number }), String(address_number)).toBe(none);
    }
    expect(canonicalNumber("12 A")).toBe("12a");
    expect(canonicalNumber("12-a")).toBe("12a");
    expect(canonicalNumber("0012")).toBe("12");
  });

  it("ignores the CEP, which often comes general or wrong", () => {
    expect(key({ cep: "25600-000" })).toBe(key({ cep: null }));
  });
});

describe("another door", () => {
  it("is a Rua and an Avenida of one name", () => {
    expect(key({ street: "Avenida Doutor Lipold" })).not.toBe(
      deliveryAddressKey(LIPOLD),
    );
    expect(key({ street: "Av. Dr. Lipold" })).not.toBe(key({}));
  });

  it("is another number, 12 and 12A included", () => {
    expect(key({ address_number: "12" })).not.toBe(
      key({ address_number: "12A" }),
    );
    expect(key({ address_number: "10" })).not.toBe(
      key({ address_number: "11" }),
    );
  });

  it("is the same street in another district, city or UF", () => {
    const here = key({});

    expect(key({ neighborhood: "Centro" })).not.toBe(here);
    expect(key({ neighborhood: null })).not.toBe(here);
    expect(key({ city: "Teresópolis" })).not.toBe(here);
    expect(key({ uf: "SP" })).not.toBe(here);
  });
});

describe("no key", () => {
  it("without a street or a city: nothing tells two doors apart", () => {
    expect(key({ street: "" })).toBeNull();
    expect(key({ street: " . " })).toBeNull();
    expect(key({ city: "" })).toBeNull();
    expect(addressKeyMaterial({ street: null, city: "Petrópolis" })).toBeNull();
  });

  it("hashes a versioned material, never the address in clear", () => {
    expect(addressKeyMaterial(LIPOLD)).toBe(
      "v1|rua doutor lipold|10|carangola|petropolis|RJ",
    );
    expect(deliveryAddressKey(LIPOLD)).not.toContain("lipold");
  });
});
