import { describe, expect, it } from "vitest";

import { disjunctiveFacets } from "@/shared/delivery/catalog-list";

import { summarizeShipperList } from "@/modules/shipper/usecases/list-shipper/shipper-list";
import { summarizeOccurrenceTypeList } from "@/modules/occurrence-type/usecases/list-occurrence-type/occurrence-type-list";
import { summarizeStatusReasonList } from "@/modules/status-change-reason/usecases/list-status-change-reason/status-change-reason-list";
import { summarizeImportList } from "@/modules/import/usecases/list-imports/import-list";

import { listShipperSchema } from "@/schemas/list-shipper-schema";
import { listOccurrenceTypeSchema } from "@/schemas/list-occurrence-type-schema";
import { listImportsSchema } from "@/schemas/import-spreadsheet-schema";

/**
 * The Entregas catalog tabs on the server (decision 8.8).
 *
 * Their filters used to run over the ten rows on screen: "Inativos" on page 1
 * of a catalogue with forty entries showed the inactive ones among those ten
 * while the pager still said "Página 1 de 4". One GROUP BY over the filtered
 * columns now answers the pager total, the cards and every filter count.
 */

describe("the disjunctive counts", () => {
  const groups = [
    { values: { status: "active", blocking: "yes" }, count: 3 },
    { values: { status: "active", blocking: "no" }, count: 5 },
    { values: { status: "inactive", blocking: "yes" }, count: 1 },
    { values: { status: "inactive", blocking: "no" }, count: 2 },
  ];

  const domains = { status: ["active", "inactive"], blocking: ["yes", "no"] } as const;

  it("counts each filter with the others applied, never its own", () => {
    const { total, facets } = disjunctiveFacets(
      groups,
      { status: ["inactive"], blocking: ["yes"] },
      domains,
    );

    // The pager: both filters.
    expect(total).toBe(1);

    // Status options, with blocking=yes applied but not status itself:
    // choosing "Inativo" does not turn "Ativo" into a zero.
    expect(facets.status).toEqual([
      { value: "active", count: 3 },
      { value: "inactive", count: 1 },
    ]);

    expect(facets.blocking).toEqual([
      { value: "yes", count: 1 },
      { value: "no", count: 2 },
    ]);
  });

  it("keeps everything when nothing is chosen, and lists empty values with 0", () => {
    const { total, facets } = disjunctiveFacets(
      [groups[0]],
      {},
      domains,
    );

    expect(total).toBe(3);
    expect(facets.status).toEqual([
      { value: "active", count: 3 },
      { value: "inactive", count: 0 },
    ]);
  });
});

describe("the shippers' cards and filter", () => {
  it("counts the cards over the search, without the Status filter", () => {
    const { total, searchMeta } = summarizeShipperList(
      [
        { is_active: true, count: 30, withCnpj: 20 },
        { is_active: false, count: 12, withCnpj: 4 },
      ],
      { statuses: ["inactive"] },
    );

    expect(total).toBe(12);
    expect(searchMeta).toMatchObject({ total: 42, active: 30, withCnpj: 24 });
    expect(searchMeta.facets.status).toEqual([
      { value: "active", count: 30 },
      { value: "inactive", count: 12 },
    ]);
  });
});

describe("the occurrence types' cards and filters", () => {
  it("counts each card without its own filter", () => {
    const { total, searchMeta } = summarizeOccurrenceTypeList(
      [
        { is_active: true, blocks_delivery: true, requires_photo: true, category: "NOT_DELIVERED", count: 2 },
        { is_active: true, blocks_delivery: false, requires_photo: false, category: "NOT_DELIVERED", count: 4 },
        { is_active: false, blocks_delivery: true, requires_photo: false, category: "NOT_DELIVERED", count: 1 },
      ],
      { blocking: ["yes"] },
    );

    // Pager: impeditivas only.
    expect(total).toBe(3);

    // Total/Ativos: with blocking=yes (the other filter), without status.
    expect(searchMeta.total).toBe(3);
    expect(searchMeta.active).toBe(2);

    // Impeditivos: without the blocking filter itself.
    expect(searchMeta.blocking).toBe(3);

    // Exigem foto: with blocking=yes applied.
    expect(searchMeta.requiringPhoto).toBe(2);
  });
});

describe("the status reasons' cards", () => {
  it("carries the used count next to the Status breakdown", () => {
    const { total, searchMeta } = summarizeStatusReasonList(
      [
        { is_active: true, count: 6 },
        { is_active: false, count: 2 },
      ],
      3,
      { statuses: ["active"] },
    );

    expect(total).toBe(6);
    expect(searchMeta).toMatchObject({ total: 8, active: 6, used: 3 });
  });
});

describe("the imports' filters", () => {
  it("answers the pager and both filters from the grouped counts", () => {
    const { total, searchMeta } = summarizeImportList(
      [
        { status: "COMPLETED", source: "SPREADSHEET", count: 7 },
        { status: "COMPLETED", source: "NFE_XML", count: 3 },
        { status: "REVERSED", source: "SPREADSHEET", count: 2 },
      ],
      { sources: ["NFE_XML"] },
    );

    expect(total).toBe(3);
    expect(searchMeta.facets.status).toEqual([
      { value: "IN_PROGRESS", count: 0 },
      { value: "COMPLETED", count: 3 },
      { value: "REVERSED", count: 0 },
    ]);
    expect(searchMeta.facets.source).toEqual([
      { value: "SPREADSHEET", count: 9 },
      { value: "NFE_XML", count: 3 },
    ]);
  });
});

describe("the query strings", () => {
  it("take the sort and the filters, and refuse what the list does not know", () => {
    const shipper = listShipperSchema.safeParse({
      page: "1",
      pageSize: "10",
      sort: "name",
      order: "desc",
      status: "inactive",
    });

    expect(shipper.success && shipper.data.status).toEqual(["inactive"]);

    expect(
      listShipperSchema.safeParse({ page: "1", pageSize: "10", sort: "cnpj" }).success,
    ).toBe(false);

    const types = listOccurrenceTypeSchema.safeParse({
      page: "1",
      pageSize: "10",
      blocking: "yes,no",
      photo: "maybe",
    });

    expect(types.success).toBe(false);

    const imports = listImportsSchema.safeParse({
      page: "1",
      pageSize: "10",
      source: "NFE_XML",
      status: "COMPLETED,REVERSED",
    });

    expect(imports.success && imports.data.status).toEqual(["COMPLETED", "REVERSED"]);
  });
});
