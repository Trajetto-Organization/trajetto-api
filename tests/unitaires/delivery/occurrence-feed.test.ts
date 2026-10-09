import { describe, expect, it } from "vitest";

import {
  occurrenceFeedWhere,
  severityAsBlocking,
  summarizeOccurrenceFeed,
  type OccurrenceTypeCount,
} from "@/modules/delivery/usecases/list-occurrences/occurrence-feed";

/**
 * How the feed's pager, cards and filter options come out of one GROUP BY
 * (decision 8.8). The disjunctive rule: a number broken down by a facet is
 * counted with every other filter, never with its own.
 */
const BUSINESS = "018f0000-0000-7000-8000-00000000000b";

const AUSENTE: OccurrenceTypeCount = {
  id: "018f0000-0000-7000-8000-0000000000a1",
  name: "Destinatário ausente",
  blocks_delivery: false,
  count: 5,
};

const RECUSA: OccurrenceTypeCount = {
  id: "018f0000-0000-7000-8000-0000000000a2",
  name: "Recusa",
  blocks_delivery: true,
  count: 3,
};

const AVARIA: OccurrenceTypeCount = {
  id: "018f0000-0000-7000-8000-0000000000a3",
  name: "Avaria",
  blocks_delivery: true,
  count: 2,
};

const COUNTS = [AUSENTE, RECUSA, AVARIA];

describe("summarizeOccurrenceFeed", () => {
  it("without facets, the pager and the cards agree", () => {
    const { total, searchMeta } = summarizeOccurrenceFeed(COUNTS, {});

    expect(total).toBe(10);
    expect(searchMeta).toMatchObject({ total: 10, blocking: 5, informational: 5 });
    expect(searchMeta.facets.severity).toEqual([
      { value: "blocking", count: 5 },
      { value: "informational", count: 5 },
    ]);
  });

  it("lists the type options alphabetically, with names", () => {
    const { searchMeta } = summarizeOccurrenceFeed(COUNTS, {});

    expect(searchMeta.facets.occurrenceTypeId.map((option) => option.label)).toEqual([
      "Avaria",
      "Destinatário ausente",
      "Recusa",
    ]);
  });

  it("a severity filter narrows the pager and the type options, not the cards", () => {
    const { total, searchMeta } = summarizeOccurrenceFeed(COUNTS, {
      severity: ["blocking"],
    });

    // The table: only blocking rows.
    expect(total).toBe(5);

    // The cards keep the whole breakdown; "Informativas" is not a zero.
    expect(searchMeta).toMatchObject({ total: 10, blocking: 5, informational: 5 });

    // The Tipo options are the blocking types only.
    expect(searchMeta.facets.occurrenceTypeId.map((option) => option.value)).toEqual([
      AVARIA.id,
      RECUSA.id,
    ]);
  });

  it("a type filter narrows the pager and the cards, not the type options", () => {
    const { total, searchMeta } = summarizeOccurrenceFeed(COUNTS, {
      occurrenceTypeIds: [RECUSA.id],
    });

    expect(total).toBe(3);
    expect(searchMeta).toMatchObject({ total: 3, blocking: 3, informational: 0 });
    expect(searchMeta.facets.occurrenceTypeId).toHaveLength(3);
  });

  it("keeps a selected type listed, at 0, when another filter excludes it", () => {
    const { total, searchMeta } = summarizeOccurrenceFeed(COUNTS, {
      severity: ["blocking"],
      occurrenceTypeIds: [AUSENTE.id],
    });

    expect(total).toBe(0);
    expect(searchMeta.facets.occurrenceTypeId).toContainEqual({
      value: AUSENTE.id,
      label: "Destinatário ausente",
      count: 0,
    });
  });

  it("both severities selected is the same as none", () => {
    expect(
      summarizeOccurrenceFeed(COUNTS, { severity: ["blocking", "informational"] }).total,
    ).toBe(10);
    expect(severityAsBlocking(["blocking", "informational"])).toBeUndefined();
    expect(severityAsBlocking(["informational"])).toBe(false);
    expect(severityAsBlocking(undefined)).toBeUndefined();
  });
});

/**
 * Decision 14.3: every proof is now a DELIVERED occurrence. It is a delivery,
 * not a problem: it must never land in a severity, and has its own count.
 */
describe("summarizeOccurrenceFeed with delivered occurrences", () => {
  const ENTREGA: OccurrenceTypeCount = {
    id: "018f0000-0000-7000-8000-0000000000a4",
    name: "Entrega normal",
    blocks_delivery: false,
    category: "DELIVERED",
    count: 7,
  };

  const WITH_PROOFS = [...COUNTS, ENTREGA];

  it("keeps proofs out of the informational severity", () => {
    const { total, searchMeta } = summarizeOccurrenceFeed(WITH_PROOFS, {
      severity: ["informational"],
    });

    expect(total).toBe(5);
    expect(searchMeta).toMatchObject({
      total: 17,
      blocking: 5,
      informational: 5,
      delivered: 7,
    });
    expect(searchMeta.facets.occurrenceTypeId.map((option) => option.value)).toEqual([
      AUSENTE.id,
    ]);
  });

  it("counts and filters by category", () => {
    const all = summarizeOccurrenceFeed(WITH_PROOFS, {});

    expect(all.total).toBe(17);
    expect(all.searchMeta.facets.category).toEqual([
      { value: "DELIVERED", count: 7 },
      { value: "NOT_DELIVERED", count: 10 },
    ]);

    const problems = summarizeOccurrenceFeed(WITH_PROOFS, { category: ["NOT_DELIVERED"] });

    expect(problems.total).toBe(10);
    expect(problems.searchMeta).toMatchObject({ total: 10, delivered: 0 });
    // The category facet ignores its own selection.
    expect(problems.searchMeta.facets.category).toEqual(all.searchMeta.facets.category);

    const proofs = summarizeOccurrenceFeed(WITH_PROOFS, { category: ["DELIVERED"] });

    expect(proofs.total).toBe(7);
    expect(proofs.searchMeta.facets.severity).toEqual([
      { value: "blocking", count: 0 },
      { value: "informational", count: 0 },
    ]);
  });

  it("a severity selection leaves the DELIVERED category at zero", () => {
    const { searchMeta } = summarizeOccurrenceFeed(WITH_PROOFS, { severity: ["blocking"] });

    expect(searchMeta.facets.category).toEqual([
      { value: "DELIVERED", count: 0 },
      { value: "NOT_DELIVERED", count: 5 },
    ]);
  });
});

describe("occurrenceFeedWhere", () => {
  it("keeps the tenant at the top level, with the facets in an AND", () => {
    const where = occurrenceFeedWhere(
      {
        businessId: BUSINESS,
        severity: ["blocking"],
        occurrenceTypeIds: [RECUSA.id],
        deliveryStatuses: ["FAILED"],
      },
      { withTypeFacets: true },
    );

    expect(where.businessId).toBe(BUSINESS);
    expect(where.AND).toEqual([
      { delivery: { status: { in: ["FAILED"] } } },
      { occurrenceTypeId: { in: [RECUSA.id] } },
      // Severity matches problems only: a proof is never "informational".
      { category: "NOT_DELIVERED", occurrenceType: { blocks_delivery: true } },
    ]);
  });

  it("the counting base drops the type and severity facets only", () => {
    const where = occurrenceFeedWhere(
      {
        businessId: BUSINESS,
        driverId: "018f0000-0000-7000-8000-0000000000d1",
        severity: ["blocking"],
        occurrenceTypeIds: [RECUSA.id],
        deliveryStatuses: ["FAILED"],
      },
      { withTypeFacets: false },
    );

    expect(where.AND).toEqual([
      { delivery: { driverId: "018f0000-0000-7000-8000-0000000000d1" } },
      { delivery: { status: { in: ["FAILED"] } } },
    ]);
  });

  it("filters one category on the row's own column; both is no filter", () => {
    expect(
      occurrenceFeedWhere(
        { businessId: BUSINESS, category: ["DELIVERED"] },
        { withTypeFacets: true },
      ).AND,
    ).toEqual([{ category: "DELIVERED" }]);

    expect(
      occurrenceFeedWhere(
        { businessId: BUSINESS, category: ["DELIVERED", "NOT_DELIVERED"] },
        { withTypeFacets: true },
      ).AND,
    ).toBeUndefined();

    // The counting base keeps every category: the facet is derived per type.
    expect(
      occurrenceFeedWhere(
        { businessId: BUSINESS, category: ["DELIVERED"] },
        { withTypeFacets: false },
      ).AND,
    ).toBeUndefined();
  });

  it("searches the literal term, not a LIKE pattern", () => {
    const where = occurrenceFeedWhere(
      { businessId: BUSINESS, search: " 50% " },
      { withTypeFacets: true },
    );

    expect(JSON.stringify(where.AND)).toContain('"contains":"50\\\\%"');
  });
});
