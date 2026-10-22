import { describe, expect, it } from "vitest";

import {
  accountPayableListWhere,
  amountOf,
  effectiveStatusGroups,
  summarizeAccountPayableList,
  type AmountRef,
  type StatusGroupCounts,
} from "@/modules/account-payable/usecases/list-account-payable/account-payable-list";

/**
 * The cards and the pager of the accounts payable list, from the three
 * situation totals the repository counts over the whole company.
 *
 * The old screen counted `totalAccounts = meta.total` (the company) but paid,
 * pending and overdue by `.filter` over the ten loaded rows, and put
 * "Pago com atraso" in both "pagas" and "vencidas".
 */

const GROUPS: StatusGroupCounts = {
  OPEN: { count: 7, amount: 1000, amountPaid: 150 },
  OVERDUE: { count: 3, amount: 600, amountPaid: 100 },
  PAID: { count: 12, amount: 2400, amountPaid: 2400 },
};

describe("summarizeAccountPayableList", () => {
  it("counts every bill once: the three cards add up to the total", () => {
    const { total, searchMeta } = summarizeAccountPayableList(GROUPS, {});

    expect(total).toBe(22);
    expect(searchMeta).toMatchObject({
      total: 22,
      open: 7,
      overdue: 3,
      paid: 12,
      openAmount: 850,
      overdueAmount: 500,
      paidAmount: 2400,
    });
    expect(searchMeta.open + searchMeta.overdue + searchMeta.paid).toBe(
      searchMeta.total,
    );
  });

  it("pages over the selected situations and keeps the cards whole", () => {
    const { total, searchMeta } = summarizeAccountPayableList(GROUPS, {
      statusGroups: ["OVERDUE", "OPEN"],
    });

    expect(total).toBe(10);
    // Disjunctive: picking "Vencida" does not zero the other cards.
    expect(searchMeta.paid).toBe(12);
    expect(searchMeta.facets.status).toEqual([
      { value: "OPEN", count: 7 },
      { value: "OVERDUE", count: 3 },
      { value: "PAID", count: 12 },
    ]);
  });

  it("treats every situation selected as no filter", () => {
    expect(effectiveStatusGroups(["OPEN", "OVERDUE", "PAID"])).toBeUndefined();
    expect(effectiveStatusGroups([])).toBeUndefined();
    expect(effectiveStatusGroups(["PAID", "PAID"])).toEqual(["PAID"]);
  });
});

describe("accountPayableListWhere", () => {
  const todayStart = new Date("2026-09-17T03:00:00.000Z");
  const amountRef = { name: "amount" } as unknown as AmountRef;

  it("keeps the tenant at the top and the status as column comparisons", () => {
    const where = accountPayableListWhere(
      { businessId: "b-1", statusGroups: ["OVERDUE"] },
      { todayStart, amountRef, withStatus: true },
    );

    expect(where.businessId).toBe("b-1");
    expect(where.AND).toEqual([
      {
        OR: [
          {
            AND: [
              {
                OR: [{ amount_paid: null }, { amount_paid: { lt: amountRef } }],
              },
              { due_date: { lt: todayStart } },
            ],
          },
        ],
      },
    ]);
  });

  it("leaves the status out of the card base", () => {
    const where = accountPayableListWhere(
      { businessId: "b-1", statusGroups: ["PAID"], categories: ["FUEL"] },
      { todayStart, amountRef, withStatus: false, onlyGroup: "PAID" },
    );

    expect(where.AND).toEqual([
      { category: { in: ["FUEL"] } },
      { amount_paid: { gte: amountRef } },
    ]);
  });

  it("matches a typed amount exactly, in reais with comma or point", () => {
    expect(amountOf("1500")).toBe(1500);
    expect(amountOf("1500,5")).toBe(1500.5);
    expect(amountOf("99.90")).toBe(99.9);
    expect(amountOf("R$ 10")).toBeNull();
    expect(amountOf("018f")).toBeNull();
  });
});
