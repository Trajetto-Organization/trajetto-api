import { describe, expect, it } from "vitest";

import {
  businessDateKey,
  businessDayRange,
  businessDayStart,
  businessDayWindow,
  businessDaysRange,
  businessMonthKey,
  businessMonthRange,
  businessMonthStart,
  businessMonthWindow,
  businessToday,
  dateOnlyFromKey,
  dateOnlyKey,
  isBrazilianTimeZone,
  isValidTimeZone,
  resolveTimeZone,
  shiftDateKey,
  shiftDateKeyByMonths,
  shiftMonthKey,
  zonedWallTimeToUtc,
} from "@/shared/time/business-day";
import {
  loadBusinessTimeZone,
  timeZoneOfBusiness,
} from "@/shared/time/business-time-zone";

const SP = "America/Sao_Paulo"; // UTC-3
const MANAUS = "America/Manaus"; // UTC-4
const NORONHA = "America/Noronha"; // UTC-2

describe("the business day of a company", () => {
  it("is still yesterday in São Paulo at 01:30 UTC — the bug that reset counters at 21:00", () => {
    const instant = new Date("2026-09-28T01:30:00.000Z"); // 22:30 on the 27th in SP

    expect(businessDateKey(instant, SP)).toBe("2026-09-27");
    expect(businessDayRange(instant, SP)).toEqual({
      start: new Date("2026-09-27T03:00:00.000Z"),
      end: new Date("2026-09-28T03:00:00.000Z"),
    });
  });

  it("follows the company's zone, not a single national one", () => {
    const instant = new Date("2026-09-28T03:30:00.000Z"); // 00:30 in SP, 23:30 in Manaus

    expect(businessDateKey(instant, SP)).toBe("2026-09-28");
    expect(businessDateKey(instant, MANAUS)).toBe("2026-09-27");
    expect(businessDayRange(instant, MANAUS).start).toEqual(new Date("2026-09-27T04:00:00.000Z"));
    expect(businessDayRange(instant, NORONHA).start).toEqual(new Date("2026-09-28T02:00:00.000Z"));
  });

  it("covers exactly 24 hours and contains the instant", () => {
    const instant = new Date("2026-12-31T23:59:59.999Z");
    const { start, end } = businessDayRange(instant, SP);

    expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000);
    expect(start.getTime()).toBeLessThanOrEqual(instant.getTime());
    expect(end.getTime()).toBeGreaterThan(instant.getTime());
  });

  it("spans the last N civil days including today", () => {
    const instant = new Date("2026-09-28T15:00:00.000Z");

    expect(businessDaysRange(instant, SP, 7)).toEqual({
      start: new Date("2026-09-22T03:00:00.000Z"),
      end: new Date("2026-09-29T03:00:00.000Z"),
    });
  });

  it("rolls months and years over at the company's midnight", () => {
    const newYearEveNight = new Date("2027-01-01T02:00:00.000Z"); // 23:00 on 31/12 in SP

    expect(businessMonthRange(newYearEveNight, SP)).toEqual({
      start: new Date("2026-12-01T03:00:00.000Z"),
      end: new Date("2027-01-01T03:00:00.000Z"),
    });
  });

  it("still honours historical daylight saving time in the tz data", () => {
    // 2018-11-04: São Paulo moved to UTC-2 at midnight (the day starts at 01:00 local).
    const dstDay = new Date("2018-11-04T15:00:00.000Z");
    const { start, end } = businessDayRange(dstDay, SP);

    expect(businessDateKey(start, SP)).toBe("2018-11-04");
    expect(end.getTime() - start.getTime()).toBe(23 * 60 * 60 * 1000);
  });

  it("picks the earliest instant when a wall time happened twice (end of DST)", () => {
    // 2019-02-16: at 00:00 of the 17th São Paulo went back to 23:00 of the 16th.
    expect(zonedWallTimeToUtc(SP, 2019, 2, 16, 23, 30)).toEqual(new Date("2019-02-17T01:30:00.000Z"));
  });

  it("converts a wall-clock time to the UTC instant", () => {
    expect(zonedWallTimeToUtc(SP, 2026, 9, 28, 8, 30)).toEqual(new Date("2026-09-28T11:30:00.000Z"));
  });
});

describe("date-only values (@db.Date columns)", () => {
  it("are UTC midnight of the civil day, so they never shift with the viewer's zone", () => {
    expect(dateOnlyFromKey("2026-09-17")).toEqual(new Date("2026-09-17T00:00:00.000Z"));
    expect(dateOnlyKey(new Date("2026-09-17T00:00:00.000Z"))).toBe("2026-09-17");
  });

  it("refuse impossible or malformed days instead of rolling them over", () => {
    expect(() => dateOnlyFromKey("2026-02-30")).toThrow(RangeError);
    expect(() => dateOnlyFromKey("17/09/2026")).toThrow(RangeError);
    expect(() => dateOnlyFromKey("2026-9-7")).toThrow(RangeError);
  });

  it("gives today's date for the company at night in UTC", () => {
    const lateNightInSaoPaulo = new Date("2026-09-18T02:00:00.000Z"); // 23:00 on the 17th

    expect(businessToday(SP, lateNightInSaoPaulo)).toEqual(new Date("2026-09-17T00:00:00.000Z"));
  });
});

describe("the company's time zone", () => {
  it("accepts Brazilian IANA zones only", () => {
    expect(isBrazilianTimeZone("America/Cuiaba")).toBe(true);
    expect(isBrazilianTimeZone("Europe/Lisbon")).toBe(false);
    expect(isBrazilianTimeZone("America/Sao Paulo")).toBe(false);
  });

  it("falls back to São Paulo when a row carries nothing usable", () => {
    expect(isValidTimeZone("Mars/Olympus_Mons")).toBe(false);
    expect(resolveTimeZone(null)).toBe(SP);
    expect(resolveTimeZone("")).toBe(SP);
    expect(resolveTimeZone("Mars/Olympus_Mons")).toBe(SP);
    expect(resolveTimeZone(MANAUS)).toBe(MANAUS);
  });
});

describe("chart buckets in the company's calendar", () => {
  const RIO_BRANCO = "America/Rio_Branco"; // UTC-5

  it("moves day and month keys without a clock", () => {
    expect(shiftDateKey("2026-09-28", 3)).toBe("2026-10-01");
    expect(shiftDateKey("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftMonthKey("2026-01", -1)).toBe("2025-12");
    expect(shiftMonthKey("2026-11", 14)).toBe("2028-01");
    expect(() => shiftMonthKey("2026-13", 1)).toThrow(RangeError);
  });

  it("adds months to a day like Postgres: clamped to the end of the month", () => {
    // JS setMonth would roll 31/08 + 1 month over to 01/10.
    expect(shiftDateKeyByMonths("2026-08-31", 1)).toBe("2026-09-30");
    expect(shiftDateKeyByMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(shiftDateKeyByMonths("2028-01-31", 1)).toBe("2028-02-29");
    expect(shiftDateKeyByMonths("2026-03-27", 6)).toBe("2026-09-27");
    expect(shiftDateKeyByMonths("2026-11-15", 3)).toBe("2027-02-15");
    expect(shiftDateKeyByMonths("2026-03-31", -1)).toBe("2026-02-28");
    expect(() => shiftDateKeyByMonths("2026-02-30", 1)).toThrow(RangeError);
  });

  it("names the month of the company's wall clock", () => {
    // 02:00 UTC on the 1st is still the 31st of the previous month in SP.
    expect(businessMonthKey(new Date("2026-10-01T02:00:00.000Z"), SP)).toBe("2026-09");
    expect(businessMonthKey(new Date("2026-10-01T04:00:00.000Z"), SP)).toBe("2026-10");
  });

  it("starts days and months at the company's midnight", () => {
    expect(businessDayStart("2026-09-17", SP)).toEqual(new Date("2026-09-17T03:00:00.000Z"));
    expect(businessDayStart("2026-09-17", RIO_BRANCO)).toEqual(new Date("2026-09-17T05:00:00.000Z"));
    expect(businessMonthStart("2026-09", MANAUS)).toEqual(new Date("2026-09-01T04:00:00.000Z"));
  });

  it("lists the last N days at 22:30 in São Paulo, a UTC runner's tomorrow", () => {
    // The old code built this window from the server's calendar: on a UTC
    // container at 22:30 BRT the last bucket was already the 28th.
    const window = businessDayWindow(new Date("2026-09-28T01:30:00.000Z"), SP, 7);

    expect(window.keys).toEqual([
      "2026-09-21",
      "2026-09-22",
      "2026-09-23",
      "2026-09-24",
      "2026-09-25",
      "2026-09-26",
      "2026-09-27",
    ]);
    expect(window.start).toEqual(new Date("2026-09-21T03:00:00.000Z"));
    expect(window.end).toEqual(new Date("2026-09-28T03:00:00.000Z"));
  });

  it("lists the last N months across a year boundary", () => {
    const window = businessMonthWindow(new Date("2027-01-01T02:00:00.000Z"), SP, 6);

    // Still December 2026 in São Paulo.
    expect(window.keys).toEqual([
      "2026-07",
      "2026-08",
      "2026-09",
      "2026-10",
      "2026-11",
      "2026-12",
    ]);
    expect(window.start).toEqual(new Date("2026-07-01T03:00:00.000Z"));
    expect(window.end).toEqual(new Date("2027-01-01T03:00:00.000Z"));
  });
});

describe("reading a company's zone", () => {
  it("takes the row's zone and falls back to the default", () => {
    expect(timeZoneOfBusiness({ timezone: MANAUS })).toBe(MANAUS);
    expect(timeZoneOfBusiness({ timezone: "Mars/Olympus_Mons" })).toBe(SP);
    expect(timeZoneOfBusiness({ corporate_reason: "Sem coluna" })).toBe(SP);
    expect(timeZoneOfBusiness(null)).toBe(SP);
  });

  it("asks the repository only when there is a company", async () => {
    const asked: string[] = [];
    const lookup = {
      findBusinessById: async (id: string) => {
        asked.push(id);
        return { id, timezone: NORONHA };
      },
    };

    expect(await loadBusinessTimeZone(lookup, "empresa-a")).toBe(NORONHA);
    expect(await loadBusinessTimeZone(lookup, undefined)).toBe(SP);
    expect(asked).toEqual(["empresa-a"]);
  });
});
