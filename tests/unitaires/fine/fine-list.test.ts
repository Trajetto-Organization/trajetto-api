import { describe, expect, it } from "vitest";

import {
  FINE_STATUSES,
  fineListWhere,
  fineSearchWhere,
  fineStatus,
  selectedStatuses,
  summarizeFineList,
  type FineListGroup,
} from "@/modules/fine/usecases/list-fine/fine-list";

import { businessDayRange } from "@/shared/time/business-day";

/**
 * The fines list's rules without a database: the payment status on the
 * company's business day, the where the filters become, and the cards and
 * filter counts derived from the per-status groups (decision 8.8). The web
 * used to count "Pagas" and "Pendentes" over the ten rows of the page.
 */

const SP = "America/Sao_Paulo";

// 28/09/2026 22:30 in São Paulo = 29/09 01:30 UTC: the UTC day is already
// tomorrow, the company's is not.
const NOW = new Date("2026-09-29T01:30:00.000Z");
const TODAY_START = businessDayRange(NOW, SP).start;

// What the web posts for a picked day: local midnight.
const localMidnight = (day: string) => new Date(`${day}T03:00:00.000Z`);

describe("fineStatus", () => {
  it("is PAID when a payment date is recorded, whatever the due date", () => {
    expect(
      fineStatus(
        {
          payment_date: localMidnight("2026-09-01"),
          due_date: localMidnight("2026-08-01"),
        },
        TODAY_START,
      ),
    ).toBe("PAID");
  });

  it("is PENDING on the due day itself: it can still be paid today", () => {
    expect(
      fineStatus(
        { payment_date: null, due_date: localMidnight("2026-09-28") },
        TODAY_START,
      ),
    ).toBe("PENDING");
  });

  it("is OVERDUE from the day after the due day", () => {
    expect(
      fineStatus(
        { payment_date: null, due_date: localMidnight("2026-09-27") },
        TODAY_START,
      ),
    ).toBe("OVERDUE");
  });

  it("reads the company's day, not the server's UTC day", () => {
    // At 22:30 in São Paulo the UTC day is the 29th; a fine due on the 28th
    // is still within its day for the company.
    expect(TODAY_START.toISOString()).toBe("2026-09-28T03:00:00.000Z");
  });
});

describe("selectedStatuses", () => {
  it("drops a selection that keeps every row", () => {
    expect(selectedStatuses({ statuses: [...FINE_STATUSES] })).toBeUndefined();
    expect(selectedStatuses({ statuses: [] })).toBeUndefined();
    expect(selectedStatuses({ statuses: ["PAID", "PAID"] })).toEqual(["PAID"]);
  });
});

describe("fineListWhere", () => {
  const filters = {
    businessId: "business-a",
    statuses: ["OVERDUE" as const],
    branchIds: ["branch-1"],
    trafficViolationCodeIds: ["code-1"],
    search: "ABC",
  };

  it("keeps the tenant as a top-level key, outside any OR", () => {
    const where = fineListWhere(filters, {
      withFacets: true,
      todayStart: TODAY_START,
    });

    expect(where.businessId).toBe("business-a");
    expect(where.OR).toBeUndefined();
  });

  it("the base (for the counts) carries the search but no facet", () => {
    const where = fineListWhere(filters, {
      withFacets: false,
      todayStart: TODAY_START,
    });

    expect(where.AND).toHaveLength(1);
    expect(JSON.stringify(where)).not.toContain("branch-1");
    expect(JSON.stringify(where)).toContain("ABC");
  });

  it("turns the status facet into the same line fineStatus draws", () => {
    const where = fineListWhere(
      { businessId: "b", statuses: ["OVERDUE"] },
      { withFacets: true, todayStart: TODAY_START },
    );

    expect(where.AND).toEqual([
      { OR: [{ payment_date: null, due_date: { lt: TODAY_START } }] },
    ]);
  });
});

describe("fineSearchWhere", () => {
  const conditionsOf = (term: string) =>
    (fineSearchWhere(term).OR ?? []) as Array<Record<string, unknown>>;

  it("finds a code as printed on the notice", () => {
    expect(conditionsOf("745-50")).toContainEqual({
      trafficViolationCode: { code: "745", sub_code: 50 },
    });
  });

  it("finds an amount typed with a comma", () => {
    const amount = conditionsOf("293,47").find(
      (condition) => "amount" in condition,
    ) as { amount: { equals: { toString(): string } } };

    expect(amount.amount.equals.toString()).toBe("293.47");
  });

  it("does not read a huge number as a sub-code", () => {
    expect(
      conditionsOf("745-999999999").some(
        (condition) =>
          "trafficViolationCode" in condition &&
          "code" in (condition.trafficViolationCode as object),
      ),
    ).toBe(false);
  });

  it("takes % and _ literally", () => {
    expect(conditionsOf("50%_")).toContainEqual({
      id: { contains: "50\\%\\_", mode: "insensitive" },
    });
  });
});

describe("summarizeFineList", () => {
  const groups: FineListGroup[] = [
    {
      status: "PAID",
      branchId: "b1",
      trafficViolationCodeId: "c1",
      count: 4,
      amount: "400.00",
    },
    {
      status: "PENDING",
      branchId: "b1",
      trafficViolationCodeId: "c2",
      count: 2,
      amount: "150.50",
    },
    {
      status: "OVERDUE",
      branchId: "b2",
      trafficViolationCodeId: "c1",
      count: 3,
      amount: "90.25",
    },
    {
      status: "OVERDUE",
      branchId: "b1",
      trafficViolationCodeId: "c1",
      count: 1,
      amount: "10.00",
    },
  ];

  const labels = {
    branchId: { b1: "Filial Centro", b2: "Filial Norte" },
    trafficViolationCodeId: { c1: "745-50", c2: "501-00" },
  };

  it("counts the whole base when nothing is filtered", () => {
    const { total, searchMeta } = summarizeFineList(groups, labels, {});

    expect(total).toBe(10);
    expect(searchMeta).toMatchObject({
      total: 10,
      paid: 4,
      pending: 2,
      overdue: 4,
      totalAmount: 650.75,
      openAmount: 250.75,
    });
  });

  it("keeps the cards whole under a status filter (disjunctive rule)", () => {
    const { total, searchMeta } = summarizeFineList(groups, labels, {
      statuses: ["OVERDUE"],
    });

    // The pager follows the filter; the cards do not zero the other statuses.
    expect(total).toBe(4);
    expect(searchMeta.paid).toBe(4);
    expect(searchMeta.pending).toBe(2);
    expect(searchMeta.overdue).toBe(4);
  });

  it("counts each facet's options with the other facets applied", () => {
    const { searchMeta } = summarizeFineList(groups, labels, {
      statuses: ["OVERDUE"],
      branchIds: ["b2"],
    });

    // Branch options: status applied, branch not.
    expect(searchMeta.facets.branchId).toEqual([
      { value: "b1", label: "Filial Centro", count: 1 },
      { value: "b2", label: "Filial Norte", count: 3 },
    ]);

    // Status options and cards: branch applied, status not.
    expect(searchMeta.facets.status).toEqual([
      { value: "PAID", count: 0 },
      { value: "PENDING", count: 0 },
      { value: "OVERDUE", count: 3 },
    ]);
  });

  it("keeps a selected option with no rows, but only when the catalog names it", () => {
    const { searchMeta } = summarizeFineList(groups, labels, {
      branchIds: ["b3-of-another-company"],
      trafficViolationCodeIds: ["c2"],
    });

    // An id no label resolves (another company's branch) gets no option.
    expect(searchMeta.facets.branchId.map((option) => option.value)).toEqual([
      "b1",
    ]);
    expect(searchMeta.facets.trafficViolationCodeId).toContainEqual({
      value: "c2",
      label: "501-00",
      count: 0,
    });
  });
});
