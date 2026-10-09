import { describe, expect, it } from "vitest";

import {
  driverListWhere,
  summarizeDriverList,
  type DriverGroupCount,
} from "@/modules/driver/usecases/list-driver/driver-list";

import { resolveOrderBy } from "@/shared/pagination/list-query";
import { DRIVER_SORT } from "@/modules/driver/usecases/list-driver/driver-list";

const BUSINESS = "018fe300-0000-7000-8000-00000000000a";
const NORTE = "018fe300-0000-7000-8000-0000000000b1";
const SUL = "018fe300-0000-7000-8000-0000000000b2";

const group = (
  status: DriverGroupCount["status"],
  contract_type: DriverGroupCount["contract_type"],
  cnh_category: DriverGroupCount["cnh_category"],
  branchId: string | null,
  count: number,
): DriverGroupCount => ({ status, contract_type, cnh_category, branchId, count });

/**
 * 10 drivers: 7 active (4 owned), 3 inactive (1 owned); categories E, AB and
 * none; branches Norte, Sul and none.
 */
const GROUPS: DriverGroupCount[] = [
  group("ACTIVE", "OWNED", "E", NORTE, 3),
  group("ACTIVE", "OWNED", null, null, 1),
  group("ACTIVE", "THIRD_PARTY", "AB", SUL, 3),
  group("INACTIVE", "OWNED", "E", SUL, 1),
  group("INACTIVE", "THIRD_PARTY", null, NORTE, 2),
];

const NAMES = new Map([
  [NORTE, "Filial Norte"],
  [SUL, "Filial Sul"],
]);

const counts = (entries: Array<{ value: string; count: number }>) =>
  Object.fromEntries(entries.map((entry) => [entry.value, entry.count]));

describe("summarizeDriverList", () => {
  it("counts the whole base without filters", () => {
    const { total, searchMeta } = summarizeDriverList(GROUPS, {}, NAMES);

    expect(total).toBe(10);
    expect(searchMeta).toMatchObject({
      total: 10,
      active: 7,
      inactive: 3,
      owned: 5,
      thirdParty: 5,
    });
    expect(counts(searchMeta.facets.cnh_category)).toMatchObject({
      E: 4,
      AB: 3,
      NONE: 3,
      A: 0,
    });
    expect(searchMeta.facets.branchId).toEqual([
      { value: NORTE, label: "Filial Norte", count: 5 },
      { value: SUL, label: "Filial Sul", count: 4 },
    ]);
  });

  it("keeps the status cards whole when the status filter is on (disjunctive)", () => {
    const { total, searchMeta } = summarizeDriverList(
      GROUPS,
      { statuses: ["INACTIVE"] },
      NAMES,
    );

    // The table shows the inactive ones...
    expect(total).toBe(3);
    // ...but Ativos does not drop to zero, and the option still says 7.
    expect(searchMeta.active).toBe(7);
    expect(searchMeta.inactive).toBe(3);
    expect(counts(searchMeta.facets.status)).toEqual({ ACTIVE: 7, INACTIVE: 3 });

    // Every other breakdown is counted WITH the status filter.
    expect(searchMeta.owned).toBe(1);
    expect(searchMeta.thirdParty).toBe(2);
    expect(counts(searchMeta.facets.cnh_category)).toMatchObject({ E: 1, NONE: 2 });
  });

  it("applies every other facet to a breakdown, never its own", () => {
    const { total, searchMeta } = summarizeDriverList(
      GROUPS,
      { contractTypes: ["OWNED"], cnhCategories: ["E"] },
      NAMES,
    );

    expect(total).toBe(4);
    // Status cards: owned AND category E.
    expect(searchMeta).toMatchObject({ total: 4, active: 3, inactive: 1 });
    // Contract options: category E only (both owned).
    expect(counts(searchMeta.facets.contract_type)).toEqual({
      OWNED: 4,
      THIRD_PARTY: 0,
    });
    // Category options: owned only.
    expect(counts(searchMeta.facets.cnh_category)).toMatchObject({
      E: 4,
      NONE: 1,
      AB: 0,
    });
  });

  it("matches drivers without a category through NONE", () => {
    const { total } = summarizeDriverList(GROUPS, { cnhCategories: ["NONE"] });

    expect(total).toBe(3);
  });

  it("keeps a selected branch that zeroed, with its name, and drops unknown ones", () => {
    const { searchMeta } = summarizeDriverList(
      [group("ACTIVE", "OWNED", "E", NORTE, 2)],
      { branchIds: [SUL, "018fe300-0000-7000-8000-0000000000ff"] },
      NAMES,
    );

    expect(searchMeta.facets.branchId).toEqual([
      { value: NORTE, label: "Filial Norte", count: 2 },
      { value: SUL, label: "Filial Sul", count: 0 },
    ]);
  });

  it("does not count drivers without a branch when a branch is chosen", () => {
    const { total } = summarizeDriverList(GROUPS, { branchIds: [NORTE] });

    expect(total).toBe(5);
  });
});

describe("driverListWhere", () => {
  it("keeps the tenant at the top level, whatever the filters", () => {
    const where = driverListWhere(
      {
        businessId: BUSINESS,
        search: "ana",
        statuses: ["ACTIVE"],
        branchIds: [NORTE],
      },
      { withFacets: true },
    );

    expect(where.businessId).toBe(BUSINESS);
    expect(where.AND).toHaveLength(3);
  });

  it("leaves the facets out of the base the counts are grouped over", () => {
    const where = driverListWhere(
      { businessId: BUSINESS, statuses: ["ACTIVE"], contractTypes: ["OWNED"] },
      { withFacets: false },
    );

    expect(where).toEqual({ businessId: BUSINESS });
  });

  it("turns NONE into a null category, alone or next to a real one", () => {
    expect(
      driverListWhere(
        { businessId: BUSINESS, cnhCategories: ["NONE"] },
        { withFacets: true },
      ).AND,
    ).toEqual([{ cnh_category: null }]);

    expect(
      driverListWhere(
        { businessId: BUSINESS, cnhCategories: ["E", "NONE"] },
        { withFacets: true },
      ).AND,
    ).toEqual([
      { OR: [{ cnh_category: { in: ["E"] } }, { cnh_category: null }] },
    ]);
  });

  it("searches documents by their digits and escapes LIKE wildcards", () => {
    const where = driverListWhere(
      { businessId: BUSINESS, search: "123.456" },
      { withFacets: true },
    );

    const or = (where.AND as Array<{ OR: object[] }>)[0].OR;

    expect(or).toContainEqual({ cpf: { contains: "123456", mode: "insensitive" } });

    const wild = driverListWhere(
      { businessId: BUSINESS, search: "50%" },
      { withFacets: true },
    );

    expect((wild.AND as Array<{ OR: object[] }>)[0].OR).toContainEqual({
      name: { contains: "50\\%", mode: "insensitive" },
    });
  });
});

describe("DRIVER_SORT", () => {
  it("defaults to newest first with a stable tiebreaker", () => {
    expect(resolveOrderBy(DRIVER_SORT, {})).toEqual([
      { created_at: "desc" },
      { id: "desc" },
    ]);
  });

  it("keeps drivers without a CNH expiry at the end in both directions", () => {
    expect(resolveOrderBy(DRIVER_SORT, { sort: "cnh_expires_at", order: "desc" })[0]).toEqual({
      cnh_expires_at: { sort: "desc", nulls: "last" },
    });
  });
});
