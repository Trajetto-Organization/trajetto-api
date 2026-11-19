import { describe, expect, it } from "vitest";

import {
  BACKFILL_DAYS_PER_ROUND,
  RECOUNTED_CLOSED_DAYS,
  civilDaysOfUtcDay,
  dayBounds,
  daysBetween,
  deliveryMetric,
  planMetric,
  rollupZones,
  zoneCalendar,
} from "@/shared/rollup/tenant-day-rules";
import {
  businessDateKey,
  businessMonthWindow,
  shiftDateKey,
} from "@/shared/time/business-day";

/**
 * The rules of the dashboard's closed days (plano-escala F4-21, decision
 * D52), in the zones whose calendars disagree with UTC and with each other.
 * A stored day is exact only if it is cut at the zone's own midnights, and
 * a reader can trust the stored days only if they never have a hole: both
 * are pinned here, without a database.
 */

// 02:30 UTC on 19/11: still 18/11 in São Paulo (−3) and Manaus (−4),
// already 19/11 in Noronha (−2).
const NOW = new Date("2026-11-19T02:30:00.000Z");

const SAO_PAULO = "America/Sao_Paulo";
const MANAUS = "America/Manaus";
const NORONHA = "America/Noronha";

describe("the zones a company is counted in", () => {
  it("is the platform's alone for a company on the platform's calendar", () => {
    expect(rollupZones(SAO_PAULO)).toEqual([SAO_PAULO]);
  });

  it("is its own and the platform's for a company in another zone", () => {
    expect(rollupZones(MANAUS)).toEqual([MANAUS, SAO_PAULO]);
    expect(deliveryMetric(MANAUS)).toBe("delivery@America/Manaus");
  });

  it("reads a missing or unknown zone as the platform's, like every other day", () => {
    expect(rollupZones(null)).toEqual([SAO_PAULO]);
    expect(rollupZones("Mars/Olympus_Mons")).toEqual([SAO_PAULO]);
  });
});

describe("a zone's calendar", () => {
  it("closes the day at the zone's midnight, not UTC's", () => {
    expect(zoneCalendar(NOW, SAO_PAULO).yesterday).toBe("2026-11-17");
    expect(zoneCalendar(NOW, MANAUS).yesterday).toBe("2026-11-17");
    expect(zoneCalendar(NOW, NORONHA).yesterday).toBe("2026-11-18");
  });

  it("recounts D−8 to D−1, ascending", () => {
    const calendar = zoneCalendar(NOW, NORONHA);

    expect(calendar.recounted).toHaveLength(RECOUNTED_CLOSED_DAYS);
    expect(calendar.recounted[0]).toBe("2026-11-11");
    expect(calendar.recounted[calendar.recounted.length - 1]).toBe(
      "2026-11-18",
    );
  });

  it("keeps exactly the trends' longest window: the current month and the twelve before", () => {
    for (const zone of [SAO_PAULO, MANAUS, NORONHA]) {
      const window = businessMonthWindow(NOW, zone, 13);

      expect(zoneCalendar(NOW, zone).historyStart).toBe(
        businessDateKey(window.start, zone),
      );
    }

    expect(zoneCalendar(NOW, SAO_PAULO).historyStart).toBe("2025-11-01");
  });
});

describe("the bounds of a stored day", () => {
  it("are the zone's own midnights", () => {
    expect(dayBounds("2026-11-10", SAO_PAULO)).toEqual({
      from: new Date("2026-11-10T03:00:00.000Z"),
      to: new Date("2026-11-11T03:00:00.000Z"),
    });
    expect(dayBounds("2026-11-10", NORONHA).from).toEqual(
      new Date("2026-11-10T02:00:00.000Z"),
    );
  });

  it("follow a DST change: a 23-hour day ends at the next midnight", () => {
    const { from, to } = dayBounds("2026-03-08", "America/New_York");

    expect(to.getTime() - from.getTime()).toBe(23 * 60 * 60 * 1000);
  });
});

describe("the civil days a marked UTC day touches", () => {
  it("are two in any zone apart from UTC", () => {
    expect(civilDaysOfUtcDay("2026-11-10", SAO_PAULO)).toEqual([
      "2026-11-09",
      "2026-11-10",
    ]);
    expect(civilDaysOfUtcDay("2026-11-10", "Asia/Tokyo")).toEqual([
      "2026-11-10",
      "2026-11-11",
    ]);
  });

  it("is the day itself in UTC", () => {
    expect(civilDaysOfUtcDay("2026-11-10", "UTC")).toEqual(["2026-11-10"]);
  });
});

/** Every day the metric has after the plan's recount runs. */
function storedAfter(
  coverage: { first: string; last: string },
  recount: string[],
): string[] {
  return [
    ...new Set([...daysBetween(coverage.first, coverage.last), ...recount]),
  ].sort();
}

describe("what one run counts of a metric", () => {
  const calendar = zoneCalendar(NOW, SAO_PAULO);
  const { yesterday, historyStart } = calendar;

  it("counts D−8 to D−1 for a metric with no row yet, and nothing to prune", () => {
    expect(
      planMetric({
        calendar,
        coverage: null,
        active: false,
        pendingUtcDays: [],
      }),
    ).toEqual({ recount: calendar.recounted, backfill: [], prune: false });
  });

  it("counts nothing of a quiet company whose days are all stored", () => {
    const plan = planMetric({
      calendar,
      coverage: { first: historyStart, last: yesterday },
      active: false,
      pendingUtcDays: [],
    });

    expect(plan).toEqual({ recount: [], backfill: [], prune: false });
  });

  it("counts every day after the last stored one, so a job that was off leaves no hole", () => {
    const coverage = { first: "2026-10-01", last: "2026-11-03" };
    const plan = planMetric({
      calendar,
      coverage,
      active: false,
      pendingUtcDays: [],
    });

    expect(plan.recount[0]).toBe("2026-11-04");
    expect(plan.recount[plan.recount.length - 1]).toBe(yesterday);
    expect(storedAfter(coverage, plan.recount)).toEqual(
      daysBetween(coverage.first, yesterday),
    );
  });

  it("recounts D−8 to D−1 of a company with deliveries there", () => {
    expect(
      planMetric({
        calendar,
        coverage: { first: historyStart, last: yesterday },
        active: true,
        pendingUtcDays: [],
      }).recount,
    ).toEqual(calendar.recounted);
  });

  it("recounts the closed, stored days a pending mark touches, and no other", () => {
    const plan = planMetric({
      calendar,
      coverage: { first: "2026-01-10", last: yesterday },
      active: false,
      pendingUtcDays: [
        // Both civil days stored: both counted.
        "2026-03-10",
        // Today in UTC: only the São Paulo day that has closed.
        "2026-11-18",
        // Before the first stored day: the backfill counts it fresh.
        "2026-01-05",
        // Before the history: not kept at all.
        "2025-06-01",
      ],
    });

    expect(plan.recount).toEqual(["2026-03-09", "2026-03-10", "2026-11-17"]);
  });

  it("fills the history backwards a quarter at a time, ending the day before the first row", () => {
    const plan = planMetric({
      calendar,
      coverage: { first: "2026-11-09", last: yesterday },
      active: false,
      pendingUtcDays: [],
    });

    expect(plan.backfill).toHaveLength(BACKFILL_DAYS_PER_ROUND);
    expect(plan.backfill[plan.backfill.length - 1]).toBe("2026-11-08");
    expect(plan.backfill[0]).toBe(
      shiftDateKey("2026-11-09", -BACKFILL_DAYS_PER_ROUND),
    );
  });

  it("stops the backfill at the history's first day", () => {
    const plan = planMetric({
      calendar,
      coverage: { first: "2025-12-15", last: yesterday },
      active: false,
      pendingUtcDays: [],
    });

    expect(plan.backfill).toEqual(daysBetween(historyStart, "2025-12-14"));
  });

  it("prunes the days that fell out of the history when the month turned", () => {
    expect(
      planMetric({
        calendar,
        coverage: { first: "2025-10-01", last: yesterday },
        active: false,
        pendingUtcDays: [],
      }),
    ).toEqual({ recount: [], backfill: [], prune: true });
  });

  it("starts over, pruning, when every stored day is older than the history", () => {
    expect(
      planMetric({
        calendar,
        coverage: { first: "2024-01-01", last: "2025-09-30" },
        active: true,
        pendingUtcDays: ["2026-11-10"],
      }),
    ).toEqual({ recount: calendar.recounted, backfill: [], prune: true });
  });

  it("goes on from the last row when it is the day before the history", () => {
    const coverage = { first: "2025-09-01", last: "2025-10-31" };
    const plan = planMetric({
      calendar,
      coverage,
      active: false,
      pendingUtcDays: [],
    });

    expect(plan.prune).toBe(true);
    expect(plan.recount).toEqual(daysBetween(historyStart, yesterday));
  });
});
