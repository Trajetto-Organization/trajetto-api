import { describe, expect, it } from "vitest";

import { partitionRunway } from "@/shared/health/operational-state";

/**
 * Days of driver_position partitions left (INV-07). There is no DEFAULT
 * partition on purpose, so the day the runway reaches zero every ping insert
 * is refused; the nightly job keeps about a week ahead, and three days left
 * means it has been failing for several nights.
 */
const NOW = new Date("2026-09-24T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function day(offset: number) {
  const from = Date.UTC(2026, 8, 24) + offset * DAY_MS;
  return { from, to: from + DAY_MS };
}

describe("partitionRunway", () => {
  it("counts whole days to the end of the last partition", () => {
    const runway = partitionRunway([day(-1), day(0), day(7)], NOW);

    expect(runway.partition_runway_days).toBe(7);
    expect(runway.last_partition_ends_at).toBe("2026-10-02T00:00:00.000Z");
    expect(runway.runway_ok).toBe(true);
  });

  it("is not ok with two days left", () => {
    const runway = partitionRunway([day(0), day(1), day(2)], NOW);

    expect(runway.partition_runway_days).toBe(2);
    expect(runway.runway_ok).toBe(false);
  });

  it("is not ok when there is no partition at all", () => {
    expect(partitionRunway([], NOW)).toEqual({
      partition_runway_days: null,
      last_partition_ends_at: null,
      runway_ok: false,
    });
  });

  it("has no limit with an unbounded partition", () => {
    const runway = partitionRunway(
      [day(0), { from: day(1).from, to: Infinity }],
      NOW,
    );

    expect(runway.runway_ok).toBe(true);
    expect(runway.partition_runway_days).toBeNull();
  });
});
