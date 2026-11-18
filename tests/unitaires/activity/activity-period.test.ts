import { describe, expect, it } from "vitest";
import { v7 as uuidV7 } from "uuid";

import { env } from "@/env";
import {
  activityCountTake,
  activityIdRange,
  cappedActivityTotal,
} from "@/shared/activity/activity-period";
import { uuid7Floor } from "@/shared/time/uuid7-floor";

/**
 * The period of the activity listings as ids, and the table's capped count
 * (plano-escala F2-19, decision D42).
 *
 * Once activity is partitioned by month on its id, a period read only by
 * created_at reads every month, the empty ones made ahead included; the
 * range of ids keeps it on the one or two it is in, two days wider before
 * and an hour past now, so no row of it is left out. The table's count
 * stops one row past the cap and says "10.000+" instead of scanning the
 * whole trail. Both switch off with 0.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

describe("activityIdRange", () => {
  it("runs from two days before the period to an hour past now, by default", () => {
    const start = new Date("2026-11-01T04:00:00.000Z");
    const now = new Date("2026-11-18T12:00:00.000Z");

    expect(env.ACTIVITY_ID_FLOOR_MARGIN_MS).toBe(2 * DAY_MS);
    expect(activityIdRange(start, now)).toEqual({
      gte: uuid7Floor(start.getTime() - 2 * DAY_MS),
      lt: uuid7Floor(now.getTime() + 60 * 60 * 1000),
    });
  });

  it("keeps every id minted from a day before the period to now", () => {
    const start = new Date(Date.now() - 30 * DAY_MS);
    const range = activityIdRange(start) as { gte: string; lt: string };

    for (const at of [start.getTime() - DAY_MS, start.getTime(), Date.now()]) {
      const id = uuidV7({ msecs: at });

      expect(id >= range.gte && id < range.lt).toBe(true);
    }
  });

  it("is off with a margin of 0", () => {
    expect(activityIdRange(new Date(), new Date(), 0)).toBeNull();
  });
});

describe("the capped count", () => {
  it("reads one row past the cap, 10,000 by default", () => {
    expect(env.ACTIVITY_COUNT_CAP).toBe(10_000);
    expect(activityCountTake()).toBe(10_001);
    expect(activityCountTake(0)).toBeUndefined();
  });

  it("says there are more only past the cap", () => {
    expect(cappedActivityTotal(9_999)).toEqual({
      total: 9_999,
      totalCapped: false,
    });
    expect(cappedActivityTotal(10_000)).toEqual({
      total: 10_000,
      totalCapped: false,
    });
    expect(cappedActivityTotal(10_001)).toEqual({
      total: 10_000,
      totalCapped: true,
    });
    expect(cappedActivityTotal(50_000, 0)).toEqual({
      total: 50_000,
      totalCapped: false,
    });
  });
});
