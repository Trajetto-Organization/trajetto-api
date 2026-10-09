import { describe, expect, it } from "vitest";

import {
  accountPayableSituation,
  accountPayableStatusOf,
  billDateFromInput,
  businessClock,
  type BusinessClock,
} from "@/modules/account-payable/rules/account-payable-status";
import { serviceOrderOverrunWarning } from "@/modules/account-payable/rules/service-order-overrun";

/**
 * The one place a bill's status is decided (FLEET-AP-3, decision 8.4).
 *
 * The web decided it in five copies with `now() > new Date(due_date)`. The
 * form stores the due date as local midnight, so every bill turned "Vencido"
 * at 00:00 of the very day it was due. Here the unit is the company's DAY.
 */

// A São Paulo company (UTC−3): the 17th starts at 03:00Z.
const SAO_PAULO = "America/Sao_Paulo";
const MANAUS = "America/Manaus"; // UTC−4

const at = (iso: string, zone = SAO_PAULO): BusinessClock =>
  businessClock(zone, new Date(iso));

// What the legacy form stored for "due on the 17th" in São Paulo.
const DUE_17_SP = "2026-09-17T03:00:00.000Z";

describe("a bill that nobody paid", () => {
  it("is pending all through its due day, at 00:00 and at 23:59 local", () => {
    // The old rule said "Vencido" here: now (00:00:01 local) > due (00:00).
    expect(
      accountPayableStatusOf(
        { amount: 100, due_date: DUE_17_SP },
        at("2026-09-17T03:00:01.000Z"),
      ),
    ).toBe("PENDING");

    expect(
      accountPayableStatusOf(
        { amount: 100, due_date: DUE_17_SP },
        at("2026-09-18T02:59:59.000Z"),
      ),
    ).toBe("PENDING");
  });

  it("is overdue from the first instant of the next day", () => {
    expect(
      accountPayableStatusOf(
        { amount: 100, due_date: DUE_17_SP },
        at("2026-09-18T03:00:00.000Z"),
      ),
    ).toBe("OVERDUE");
  });

  it("follows the company's zone, not the server's", () => {
    // 03:30Z on the 18th is still the 17th in Manaus (23:30): not overdue
    // for a company there, overdue for one in São Paulo.
    const dueManaus = billDateFromInput("2026-09-17", MANAUS);

    expect(
      accountPayableStatusOf(
        { amount: 100, due_date: dueManaus },
        at("2026-09-18T03:30:00.000Z", MANAUS),
      ),
    ).toBe("PENDING");

    expect(
      accountPayableStatusOf(
        { amount: 100, due_date: DUE_17_SP },
        at("2026-09-18T03:30:00.000Z", SAO_PAULO),
      ),
    ).toBe("OVERDUE");
  });

  it("reads a legacy due date stored at another hour by its civil day", () => {
    // 20:00 local on the 17th is still the 17th.
    expect(
      accountPayableStatusOf(
        { amount: 100, due_date: "2026-09-17T23:00:00.000Z" },
        at("2026-09-18T01:00:00.000Z"),
      ),
    ).toBe("PENDING");
  });
});

describe("a partly paid bill", () => {
  it("is partial before and on its due day, partial and late after it", () => {
    const bill = {
      amount: 100,
      amount_paid: 40,
      payment_date: "2026-09-10T15:00:00.000Z",
      due_date: DUE_17_SP,
    };

    expect(accountPayableStatusOf(bill, at("2026-09-17T20:00:00.000Z"))).toBe(
      "PARTIAL",
    );
    expect(accountPayableStatusOf(bill, at("2026-09-18T03:00:00.000Z"))).toBe(
      "PARTIAL_LATE",
    );
  });
});

describe("a fully paid bill", () => {
  it("was paid on time when paid on the due day, at any hour", () => {
    // 20:00 local on the 17th: the old instant comparison called it late.
    expect(
      accountPayableStatusOf(
        {
          amount: "100.00",
          amount_paid: "100.00",
          payment_date: "2026-09-17T23:00:00.000Z",
          due_date: DUE_17_SP,
        },
        at("2026-09-20T12:00:00.000Z"),
      ),
    ).toBe("PAID");
  });

  it("was paid late when paid on a later day", () => {
    expect(
      accountPayableStatusOf(
        {
          amount: 100,
          amount_paid: 100,
          payment_date: "2026-09-18T03:00:00.000Z",
          due_date: DUE_17_SP,
        },
        at("2026-09-20T12:00:00.000Z"),
      ),
    ).toBe("LATE");
  });

  it("compares money in cents, like the Decimal(10,2) columns", () => {
    expect(
      accountPayableStatusOf(
        {
          amount: "0.30",
          amount_paid: 0.1 + 0.2, // 0.30000000000000004
          payment_date: DUE_17_SP,
          due_date: DUE_17_SP,
        },
        at("2026-09-17T12:00:00.000Z"),
      ),
    ).toBe("PAID");
  });
});

describe("the situation every read carries", () => {
  it("says the due and payment DAYS in the company's zone and what is left", () => {
    expect(
      accountPayableSituation(
        {
          amount: 250,
          amount_paid: 100,
          payment_date: "2026-09-18T02:00:00.000Z", // 17th, 23:00 local
          due_date: DUE_17_SP,
        },
        at("2026-09-17T12:00:00.000Z"),
      ),
    ).toEqual({
      status: "PARTIAL",
      status_group: "OPEN",
      due_day: "2026-09-17",
      payment_day: "2026-09-17",
      remaining_amount: 150,
    });
  });
});

describe("a day sent by the form", () => {
  it("is stored as the instant that day starts in the company's zone", () => {
    expect(billDateFromInput("2026-09-17", SAO_PAULO).toISOString()).toBe(
      DUE_17_SP,
    );
    expect(billDateFromInput("2026-09-17", MANAUS).toISOString()).toBe(
      "2026-09-17T04:00:00.000Z",
    );
  });

  it("keeps an ISO instant from an older client as it is", () => {
    expect(
      billDateFromInput("2026-09-17T15:30:00.000Z", SAO_PAULO).toISOString(),
    ).toBe("2026-09-17T15:30:00.000Z");
  });
});

describe("bills above their service order's total (FLEET-AP-5)", () => {
  it("warns without refusing, and stays quiet at or below the total", () => {
    // toLocaleString separates R$ with a no-break space.
    expect(serviceOrderOverrunWarning(1500, "1200.00")?.replace(/\s/g, " ")).toBe(
      "As contas desta ordem de serviço somam R$ 1.500,00, acima do total da ordem (R$ 1.200,00). Confira se não há conta em duplicidade.",
    );
    expect(serviceOrderOverrunWarning(1200, "1200.00")).toBeNull();
    expect(serviceOrderOverrunWarning(500, 0)).toBeNull();
  });
});
