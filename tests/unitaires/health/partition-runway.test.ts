import { describe, expect, it } from "vitest";

import type { PartitionedTable } from "@/shared/database/partitions";
import {
  legacyRunway,
  partitionRunway,
  partitionTableState,
  type PartitionCatalogRow,
} from "@/shared/health/operational-state";

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

/**
 * Each registered table's partitions on /health/metrics (plano-escala
 * F2-09): the runway, the 5-day lookahead warning, partitions stuck past
 * the retention, pending detaches and whether trajetto_partitions owns them.
 * A table that keeps no lookahead (retired in favour of its successor) is
 * not judged on it: its runway shrinks by design, and an alert that cries
 * wolf every night is switched off.
 */
describe("partitionTableState", () => {
  const trail: PartitionedTable = {
    table: "driver_position",
    grain: "day",
    lookahead: 7,
    requiredBehind: 1,
    requiredAhead: 1,
    retentionDays: 90,
    settleDays: 8,
  };

  const iso = (ms: number) => new Date(ms).toISOString().replace("T", " ");

  function row(
    offset: number,
    overrides: Partial<PartitionCatalogRow> = {},
  ): PartitionCatalogRow {
    const { from, to } = day(offset);

    return {
      relname: `p${offset}`,
      bound: `FOR VALUES FROM ('${iso(from)}') TO ('${iso(to)}')`,
      detach_pending: false,
      owned: true,
      ...overrides,
    };
  }

  const week = () => [-1, 0, 1, 2, 3, 4, 5, 6, 7].map((offset) => row(offset));

  it("is all well with a week ahead, owned by the role", () => {
    expect(partitionTableState(trail, { owned: true }, week(), NOW)).toEqual({
      partitions: 9,
      lookahead_days: 7,
      last_partition_ends_at: "2026-10-02T00:00:00.000Z",
      oldest_partition_starts_at: "2026-09-23T00:00:00.000Z",
      retention_days: 90,
      runway_ok: true,
      lookahead_ok: true,
      detach_pending: 0,
      stuck: [],
      owner_ok: true,
    });
  });

  it("warns at 4 days ahead and pages under 3", () => {
    const four = [-1, 0, 1, 2, 3, 4].map((offset) => row(offset));
    const two = [-1, 0, 1, 2].map((offset) => row(offset));

    expect(
      partitionTableState(trail, { owned: true }, four, NOW),
    ).toMatchObject({
      lookahead_days: 4,
      runway_ok: true,
      lookahead_ok: false,
    });
    expect(partitionTableState(trail, { owned: true }, two, NOW)).toMatchObject(
      {
        lookahead_days: 2,
        runway_ok: false,
        lookahead_ok: false,
      },
    );

    // Five is still fine: the job's 7 minus one missed night and a bit.
    const five = [-1, 0, 1, 2, 3, 4, 5].map((offset) => row(offset));

    expect(
      partitionTableState(trail, { owned: true }, five, NOW).lookahead_ok,
    ).toBe(true);
  });

  it("lists a partition past the retention by more than 3 days, and not the one just past it", () => {
    const state = partitionTableState(
      trail,
      { owned: true },
      [
        row(-95),
        row(-94),
        row(-92),
        row(-91, { detach_pending: true }),
        ...week(),
      ],
      NOW,
    );

    // The cutoff is 2026-06-26: p-91 ends on it (due tonight, pending), and
    // only what ended 3 days before it is stuck.
    expect(state.stuck).toEqual(["p-94", "p-95"]);
    expect(state.detach_pending).toBe(1);
  });

  it("is not owner_ok with the parent or one partition under another owner", () => {
    expect(
      partitionTableState(trail, { owned: false }, week(), NOW).owner_ok,
    ).toBe(false);
    expect(
      partitionTableState(
        trail,
        { owned: true },
        [...week(), row(8, { owned: false })],
        NOW,
      ).owner_ok,
    ).toBe(false);
    expect(partitionTableState(trail, null, [], NOW)).toMatchObject({
      partitions: 0,
      lookahead_days: null,
      runway_ok: false,
      owner_ok: false,
    });
  });

  it("does not judge the lookahead of a table that keeps none", () => {
    const retired = { ...trail, lookahead: 0 };
    const state = partitionTableState(retired, { owned: true }, [row(-1)], NOW);

    expect(state).toMatchObject({ runway_ok: true, lookahead_ok: true });
  });

  it("keeps the old driver_position shape as an alias", () => {
    const state = partitionTableState(trail, { owned: true }, week(), NOW);

    expect(legacyRunway(state)).toEqual({
      partition_runway_days: 7,
      last_partition_ends_at: "2026-10-02T00:00:00.000Z",
      runway_ok: true,
    });
    expect(legacyRunway(undefined)).toEqual({
      partition_runway_days: null,
      last_partition_ends_at: null,
      runway_ok: false,
    });
  });
});
