import { describe, expect, it } from "vitest";

import {
  summarizeSupplierList,
  supplierListWhere,
} from "@/modules/supplier/usecases/list-supplier/supplier-list";
import { describeSupplierReferences } from "@/modules/supplier/usecases/errors/supplier-in-use-error";

/**
 * The supplier cards used to be `meta.total` beside counts taken over the
 * ten loaded rows ("Com telefone: 4 (0%)" for a company of 300 suppliers).
 * Now every number comes from one GROUP BY uf over the whole company.
 */
const STATES = [
  { uf: "SP", count: 12, withTelephone: 10, withEmail: 7 },
  { uf: "MG", count: 4, withTelephone: 1, withEmail: 4 },
  { uf: "RJ", count: 4, withTelephone: 4, withEmail: 0 },
  { uf: "PR", count: 1, withTelephone: 0, withEmail: 1 },
  { uf: null, count: 2, withTelephone: 2, withEmail: 2 },
];

describe("summarizeSupplierList", () => {
  it("adds the cards over every UF, the ones without an address included", () => {
    const { total, searchMeta } = summarizeSupplierList(STATES, {});

    expect(total).toBe(23);
    expect(searchMeta).toMatchObject({
      total: 23,
      withTelephone: 17,
      withEmail: 14,
      topStates: "SP (12), MG (4), RJ (4)",
    });
  });

  it("narrows the pager and the cards to the selected UFs, not the options", () => {
    const { total, searchMeta } = summarizeSupplierList(STATES, {
      ufs: ["MG", "RJ", "AC"],
    });

    expect(total).toBe(8);
    expect(searchMeta.withTelephone).toBe(5);
    // Every UF of the base stays an option, and a selected empty one keeps
    // its chip with a zero.
    expect(searchMeta.facets.uf).toEqual([
      { value: "AC", count: 0 },
      { value: "MG", count: 4 },
      { value: "PR", count: 1 },
      { value: "RJ", count: 4 },
      { value: "SP", count: 12 },
    ]);
  });

  it("says N/A when no supplier has a UF", () => {
    expect(summarizeSupplierList([], {}).searchMeta.topStates).toBe("N/A");
  });
});

describe("supplierListWhere", () => {
  it("keeps the tenant at the top and leaves the UF out of the base", () => {
    const where = supplierListWhere(
      { businessId: "b-1", ufs: ["SP"] },
      { withUfFacet: false },
    );

    expect(where).toEqual({ businessId: "b-1" });
  });

  it("searches the digits of a formatted CNPJ against the stored digits", () => {
    const where = supplierListWhere(
      { businessId: "b-1", search: "12.345.678/0001-90" },
      { withUfFacet: true },
    );

    expect(JSON.stringify(where)).toContain(
      '"cnpj":{"contains":"12345678000190"}',
    );
  });
});

describe("the refusal of a supplier with history", () => {
  it("names what depends on it, in Portuguese", () => {
    expect(
      describeSupplierReferences({
        serviceOrders: 2,
        parts: 1,
        accountsPayable: 0,
      }),
    ).toBe("2 ordens de serviço e 1 peça");
    expect(
      describeSupplierReferences({
        serviceOrders: 1,
        parts: 3,
        accountsPayable: 4,
      }),
    ).toBe("1 ordem de serviço, 3 peças e 4 contas a pagar");
  });
});
