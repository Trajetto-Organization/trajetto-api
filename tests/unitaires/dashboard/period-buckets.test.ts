import { describe, expect, it } from "vitest";

import { periodBuckets } from "@/modules/dashboard/repositories/period-buckets";
import { businessMonthStart, zonedWallTimeToUtc } from "@/shared/time/business-day";

const SP = "America/Sao_Paulo";
const MANAUS = "America/Manaus";

const iso = (buckets: ReturnType<typeof periodBuckets>) =>
  buckets.map((bucket) => [bucket.period, bucket.start.toISOString(), bucket.end.toISOString()]);

describe("periodBuckets", () => {
  it("cuts months at the company's midnight, not UTC's", () => {
    const from = businessMonthStart("2026-08", SP);
    const to = businessMonthStart("2026-11", SP);

    expect(iso(periodBuckets(from, to, "month", SP))).toEqual([
      ["2026-08", "2026-08-01T03:00:00.000Z", "2026-09-01T03:00:00.000Z"],
      ["2026-09", "2026-09-01T03:00:00.000Z", "2026-10-01T03:00:00.000Z"],
      ["2026-10", "2026-10-01T03:00:00.000Z", "2026-11-01T03:00:00.000Z"],
    ]);

    // Manaus is an hour further west: its months start at 04:00Z.
    expect(iso(periodBuckets(businessMonthStart("2026-08", MANAUS), businessMonthStart("2026-09", MANAUS), "month", MANAUS))).toEqual([
      ["2026-08", "2026-08-01T04:00:00.000Z", "2026-09-01T04:00:00.000Z"],
    ]);
  });

  it("clips the last bucket to the window (month so far)", () => {
    const from = businessMonthStart("2026-09", SP);
    const to = zonedWallTimeToUtc(SP, 2026, 9, 7, 14, 30);

    expect(iso(periodBuckets(from, to, "month", SP))).toEqual([
      ["2026-09", "2026-09-01T03:00:00.000Z", "2026-09-07T17:30:00.000Z"],
    ]);
  });

  it("labels a window that starts mid-month by the month it starts in", () => {
    const from = zonedWallTimeToUtc(SP, 2026, 9, 30, 22, 0); // 01:00Z on Oct 1st
    const to = zonedWallTimeToUtc(SP, 2026, 10, 2);

    expect(iso(periodBuckets(from, to, "month", SP))).toEqual([
      ["2026-09", "2026-10-01T01:00:00.000Z", "2026-10-01T03:00:00.000Z"],
      ["2026-10", "2026-10-01T03:00:00.000Z", "2026-10-02T03:00:00.000Z"],
    ]);
  });

  it("cuts days, contiguous and without gaps", () => {
    const from = zonedWallTimeToUtc(SP, 2026, 9, 29);
    const to = zonedWallTimeToUtc(SP, 2026, 10, 2);
    const buckets = periodBuckets(from, to, "day", SP);

    expect(buckets.map((bucket) => bucket.period)).toEqual(["2026-09-29", "2026-09-30", "2026-10-01"]);

    for (let index = 1; index < buckets.length; index++) {
      expect(buckets[index].start).toEqual(buckets[index - 1].end);
    }

    expect(buckets[0].start).toEqual(from);
    expect(buckets[buckets.length - 1].end).toEqual(to);
  });

  it("an empty window has no buckets", () => {
    const at = zonedWallTimeToUtc(SP, 2026, 9, 1);

    expect(periodBuckets(at, at, "month", SP)).toEqual([]);
  });
});
