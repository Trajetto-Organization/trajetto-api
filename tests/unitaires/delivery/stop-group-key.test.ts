import { describe, expect, it } from "vitest";

import { stopGroupKey } from "@/shared/delivery/stop-group";

/**
 * Which stops of a route are the same visit (plan of 02/11/2026, B6;
 * decision D37): same normalized address and same recipient — document, or
 * phone without one. Three NF-e for one shop used to send the shop three
 * messages per moment; the key is what lets the message go once per stop.
 */
const shop = {
  street: "Rua das Flores",
  address_number: "120",
  complement: "Loja 2",
  city: "Cuiabá",
  uf: "MT",
  cep: "78000-000",
  recipient_document: "12.345.678/0001-90",
  recipient_telephone: "(65) 99999-0000",
};

describe("the stop group key", () => {
  it("is the same for the same address and recipient", () => {
    expect(stopGroupKey(shop)).toBe(stopGroupKey({ ...shop }));
    expect(stopGroupKey(shop)).toMatch(/^[0-9a-f]{40}$/);
  });

  it("ignores case, accents, punctuation and spacing in the address", () => {
    expect(
      stopGroupKey({
        ...shop,
        street: "  RUA DAS  FLORES ",
        city: "cuiaba",
        complement: "loja-2",
        cep: "78000000",
        recipient_document: "12345678000190",
      }),
    ).toBe(stopGroupKey(shop));
  });

  it("separates two recipients at the same address", () => {
    expect(
      stopGroupKey({ ...shop, recipient_document: "98.765.432/0001-10" }),
    ).not.toBe(stopGroupKey(shop));
  });

  it("separates the same recipient at another address", () => {
    expect(stopGroupKey({ ...shop, address_number: "121" })).not.toBe(
      stopGroupKey(shop),
    );
    expect(stopGroupKey({ ...shop, complement: "Loja 3" })).not.toBe(
      stopGroupKey(shop),
    );
  });

  it("matches by phone when there is no document", () => {
    const byPhone = { ...shop, recipient_document: null };

    expect(stopGroupKey(byPhone)).toBe(
      stopGroupKey({ ...byPhone, recipient_telephone: "65999990000" }),
    );
    expect(stopGroupKey(byPhone)).not.toBe(
      stopGroupKey({ ...byPhone, recipient_telephone: "65988880000" }),
    );
  });

  it("is null without a person to match: an address alone merges nobody", () => {
    expect(
      stopGroupKey({
        ...shop,
        recipient_document: null,
        recipient_telephone: "  ",
      }),
    ).toBeNull();
  });
});
