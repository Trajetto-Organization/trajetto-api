import { describe, expect, it } from "vitest";

import {
  basisOf,
  currentMonthStart,
  samePointLastMonth,
} from "@/modules/dashboard/usecases/shared/count-comparison";

/** The overview cards' periods, in the company's calendar. */
describe("count comparison periods", () => {
  it("splits catalogues (totals) from operations (month so far)", () => {
    for (const entity of ["vehicle", "driver", "business", "branch", "part", "supplier", "user"] as const) {
      expect(basisOf(entity), entity).toBe("total");
    }
    for (const entity of ["service-order", "fine", "delivery", "route"] as const) {
      expect(basisOf(entity), entity).toBe("month_to_date");
    }
  });

  it("starts the month in the company's zone, not in UTC", () => {
    // 02:00 UTC on 01/10 is still 30/09 in São Paulo.
    expect(currentMonthStart(new Date("2026-10-01T02:00:00.000Z"), "America/Sao_Paulo").toISOString()).toBe(
      "2026-09-01T03:00:00.000Z",
    );
    expect(currentMonthStart(new Date("2026-10-06T12:00:00.000Z"), "America/Manaus").toISOString()).toBe(
      "2026-10-01T04:00:00.000Z",
    );
  });

  it("takes last month up to the same day and time", () => {
    // 05/10 14:30 in São Paulo → 01/09 00:00 to 05/09 14:30.
    expect(samePointLastMonth(new Date("2026-10-05T17:30:00.000Z"), "America/Sao_Paulo")).toEqual({
      from: new Date("2026-09-01T03:00:00.000Z"),
      to: new Date("2026-09-05T17:30:00.000Z"),
    });
  });

  it("takes the whole previous month for a day it does not have", () => {
    // 31/10: September has 30 days.
    expect(samePointLastMonth(new Date("2026-10-31T15:00:00.000Z"), "America/Sao_Paulo")).toEqual({
      from: new Date("2026-09-01T03:00:00.000Z"),
      to: new Date("2026-10-01T03:00:00.000Z"),
    });
    // 29/03 against a 28-day February.
    expect(samePointLastMonth(new Date("2027-03-29T15:00:00.000Z"), "America/Sao_Paulo").to).toEqual(
      new Date("2027-03-01T03:00:00.000Z"),
    );
  });

  it("crosses the year in January", () => {
    expect(samePointLastMonth(new Date("2027-01-10T13:00:00.000Z"), "America/Sao_Paulo")).toEqual({
      from: new Date("2026-12-01T03:00:00.000Z"),
      to: new Date("2026-12-10T13:00:00.000Z"),
    });
  });
});
