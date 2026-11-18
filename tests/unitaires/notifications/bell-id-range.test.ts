import { describe, expect, it } from "vitest";

import { bellIdRange } from "@/shared/notifications/bell-id-range";
import { uuid7Floor } from "@/shared/time/uuid7-floor";

/**
 * The ids the bell's reads look at (plano-escala F5-15). On the bell
 * partitioned by month, a read without them plans every month attached;
 * with them, at most seven months with the 180 days of the unread
 * retention, any day of any year, and never a notification the retention
 * still keeps out of the range.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

function monthsTouched(range: { gte: string; lt: string }): number {
  const from = new Date(parseInt(range.gte.replace(/-/g, "").slice(0, 12), 16));
  const to = new Date(
    parseInt(range.lt.replace(/-/g, "").slice(0, 12), 16) - 1,
  );

  return (
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 +
    (to.getUTCMonth() - from.getUTCMonth()) +
    1
  );
}

describe("the bell's range of ids", () => {
  it("starts on the first day of the month of the oldest notification kept, and ends a day ahead", () => {
    const now = new Date("2026-11-18T10:00:00Z");

    expect(bellIdRange(180, now)).toEqual({
      gte: uuid7Floor(Date.UTC(2026, 4, 1)),
      lt: uuid7Floor(now.getTime() + DAY_MS),
    });
  });

  it("touches at most seven months with 180 days, every day of a year", () => {
    for (let day = 0; day < 366; day += 1) {
      const now = new Date(Date.UTC(2027, 0, 1, 23, 30) + day * DAY_MS);

      expect(
        monthsTouched(bellIdRange(180, now)),
        now.toISOString(),
      ).toBeLessThanOrEqual(7);
    }
  });

  it("keeps every notification inside the retention", () => {
    const now = new Date("2027-03-31T23:59:00Z");
    const range = bellIdRange(180, now);
    const oldestKept = uuid7Floor(now.getTime() - 180 * DAY_MS);

    expect(oldestKept >= range.gte).toBe(true);
    expect(uuid7Floor(now.getTime()) < range.lt).toBe(true);
  });
});
