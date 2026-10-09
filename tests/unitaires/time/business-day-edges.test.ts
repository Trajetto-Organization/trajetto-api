import { describe, expect, it } from "vitest";

import {
  DEFAULT_BUSINESS_TIMEZONE,
  dateOnlyFromKey,
  shiftDateKeyByMonths,
  shiftMonthKey,
  zonedWallTimeToUtc,
} from "@/shared/time/business-day";

/**
 * Edges of the business-day rules left alive by the 06/10 mutation run: DST
 * nights in São Paulo's history (a wall time that never happened, and one
 * that happened twice), keys with anything around them, and month keys out
 * of range. The DST cases are checked against an independent oracle: every
 * minute around the night, formatted by Intl.
 */

const SP = "America/Sao_Paulo";

const wallOf = (instant: number) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SP,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
};

/** Every instant, minute by minute around the wall time, that shows it in São Paulo. */
const instantsShowing = (wall: string, near: number) => {
  const found: number[] = [];
  for (let t = near - 6 * 3_600_000; t <= near + 6 * 3_600_000; t += 60_000) {
    if (wallOf(t) === wall) found.push(t);
  }
  return found;
};

describe("zonedWallTimeToUtc on DST nights", () => {
  it("takes the earliest instant of a wall time that happened twice (2019-02-16 23:30)", () => {
    const shown = instantsShowing("2019-02-16 23:30", Date.UTC(2019, 1, 17, 2, 30));
    expect(shown).toHaveLength(2);

    expect(zonedWallTimeToUtc(SP, 2019, 2, 16, 23, 30).getTime()).toBe(Math.min(...shown));
  });

  it("starts a day whose midnight never happened at its first instant (2018-11-04)", () => {
    expect(instantsShowing("2018-11-04 00:00", Date.UTC(2018, 10, 4, 3))).toEqual([]);

    const start = zonedWallTimeToUtc(SP, 2018, 11, 4).getTime();

    expect(wallOf(start)).toBe("2018-11-04 01:00");
    expect(wallOf(start - 60_000)).toBe("2018-11-03 23:59");
  });

  it("moves a wall time inside a spring-forward gap past the gap, east of UTC too", () => {
    // Berlin skipped 02:00-03:00 on 2026-03-29: 02:30 is read as 03:30 CEST.
    expect(zonedWallTimeToUtc("Europe/Berlin", 2026, 3, 29, 2, 30).toISOString()).toBe("2026-03-29T01:30:00.000Z");
  });

  it("takes the earliest instant of a repeated wall time east of UTC too", () => {
    // Berlin went back from 03:00 CEST to 02:00 CET on 2026-10-25: 02:30
    // happened at 00:30Z and again at 01:30Z. Red before: the later one,
    // because both guesses read the offset after the change.
    expect(zonedWallTimeToUtc("Europe/Berlin", 2026, 10, 25, 2, 30).toISOString()).toBe(
      "2026-10-25T00:30:00.000Z",
    );
    // Sydney went back from 03:00 AEDT to 02:00 AEST on 2026-04-05.
    expect(zonedWallTimeToUtc("Australia/Sydney", 2026, 4, 5, 2, 30).toISOString()).toBe(
      "2026-04-04T15:30:00.000Z",
    );
    // An hour that happened once stays where it is, on both sides.
    expect(zonedWallTimeToUtc("Europe/Berlin", 2026, 10, 25, 1, 30).toISOString()).toBe(
      "2026-10-24T23:30:00.000Z",
    );
    expect(zonedWallTimeToUtc("Europe/Berlin", 2026, 10, 25, 3, 30).toISOString()).toBe(
      "2026-10-25T02:30:00.000Z",
    );
  });

  it("is the plain offset on an ordinary day", () => {
    expect(zonedWallTimeToUtc(SP, 2026, 10, 6, 8, 15).toISOString()).toBe("2026-10-06T11:15:00.000Z");
  });
});

describe("keys", () => {
  it("defaults to São Paulo", () => {
    expect(DEFAULT_BUSINESS_TIMEZONE).toBe("America/Sao_Paulo");
  });

  it("refuses a date key with anything around it, naming it", () => {
    for (const key of ["x2026-10-06", "2026-10-06x", "2026-10-6"]) {
      expect(() => dateOnlyFromKey(key)).toThrow(`Invalid date-only key: ${key}`);
    }
    expect(() => dateOnlyFromKey("2026-02-30")).toThrow("Invalid date-only key: 2026-02-30");
  });

  it("refuses a month key with anything around it or out of range, naming it", () => {
    for (const key of ["x2026-10", "2026-10x", "2026-00", "2026-13"]) {
      expect(() => shiftMonthKey(key, 1)).toThrow(`Invalid month key: ${key}`);
    }
    expect(shiftMonthKey("2026-12", 1)).toBe("2027-01");
    expect(shiftMonthKey("2026-01", 0)).toBe("2026-01");
  });

  it("keeps a single-digit day padded when moving by months", () => {
    expect(shiftDateKeyByMonths("2026-01-05", 1)).toBe("2026-02-05");
    expect(shiftDateKeyByMonths("2026-01-31", 1)).toBe("2026-02-28");
  });
});
