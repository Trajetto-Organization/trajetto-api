import { describe, expect, it } from "vitest";

import {
  parsePartitionBound,
  partitionMayStillBeCreated,
  splitByPartition,
} from "@/shared/route/driver-position-rules";

/**
 * Which points of a flush driver_position can hold, decided without a
 * database once the partition bounds are known (INV-14).
 *
 * The table has no DEFAULT partition, so a point with no partition fails the
 * whole INSERT. The repository reads the bounds only after such a failure and
 * splits the flush with these rules: the points that fit are written, the ones
 * whose partition can never appear are dropped, and a point whose partition
 * the nightly job will still create keeps the flush failing so the phone
 * holds on to it.
 */
const at = (iso: string) => ({ recorded_at: new Date(iso) });

describe("parsePartitionBound", () => {
  it("reads the range pg_get_expr prints for a day partition, in UTC", () => {
    expect(
      parsePartitionBound(
        "FOR VALUES FROM ('2026-09-14 00:00:00') TO ('2026-09-15 00:00:00')",
      ),
    ).toEqual({
      from: Date.UTC(2026, 8, 14),
      to: Date.UTC(2026, 8, 15),
    });
  });

  it("keeps fractional seconds and explicit offsets", () => {
    expect(
      parsePartitionBound(
        "FOR VALUES FROM ('2026-09-14 00:00:00.5') TO ('2026-09-15 03:00:00+03')",
      ),
    ).toEqual({
      from: Date.UTC(2026, 8, 14, 0, 0, 0, 500),
      to: Date.UTC(2026, 8, 15),
    });
  });

  it("treats MINVALUE and MAXVALUE as open ends", () => {
    expect(
      parsePartitionBound("FOR VALUES FROM (MINVALUE) TO (MAXVALUE)"),
    ).toEqual({ from: -Infinity, to: Infinity });
  });

  it("ignores DEFAULT and anything it cannot read", () => {
    expect(parsePartitionBound("DEFAULT")).toBeNull();
    expect(parsePartitionBound("FOR VALUES IN ('a')")).toBeNull();
    expect(
      parsePartitionBound(
        "FOR VALUES FROM ('not a date') TO ('2026-09-15 00:00:00')",
      ),
    ).toBeNull();
  });
});

describe("splitByPartition", () => {
  const ranges = [
    { from: Date.UTC(2026, 8, 23), to: Date.UTC(2026, 8, 24) },
    { from: Date.UTC(2026, 8, 24), to: Date.UTC(2026, 8, 25) },
  ];

  it("keeps the points inside a partition and sets the rest apart, in order", () => {
    const points = [
      at("2026-09-23T10:00:00Z"),
      at("2026-08-15T06:38:36Z"),
      at("2026-09-24T23:59:59.999Z"),
      at("2026-09-30T00:00:00Z"),
    ];

    const { writable, orphaned } = splitByPartition(points, ranges);

    expect(writable).toEqual([points[0], points[2]]);
    expect(orphaned).toEqual([points[1], points[3]]);
  });

  it("puts midnight in the partition that starts there: FROM inclusive, TO exclusive", () => {
    const { writable } = splitByPartition(
      [at("2026-09-24T00:00:00.000Z"), at("2026-09-25T00:00:00.000Z")],
      ranges,
    );

    expect(writable).toEqual([at("2026-09-24T00:00:00.000Z")]);
  });

  it("finds nothing writable when there are no partitions at all", () => {
    const points = [at("2026-09-24T10:00:00Z")];

    expect(splitByPartition(points, [])).toEqual({
      writable: [],
      orphaned: points,
    });
  });
});

describe("partitionMayStillBeCreated", () => {
  // The nightly job creates from YESTERDAY onward, never behind it.
  const now = new Date("2026-09-24T02:30:00Z");

  it("is true from yesterday's UTC midnight on, including the future", () => {
    expect(
      partitionMayStillBeCreated(new Date("2026-09-23T00:00:00Z"), now),
    ).toBe(true);
    expect(
      partitionMayStillBeCreated(new Date("2026-09-24T02:00:00Z"), now),
    ).toBe(true);
    expect(
      partitionMayStillBeCreated(new Date("2026-10-10T00:00:00Z"), now),
    ).toBe(true);
  });

  it("is false for anything before yesterday: no run will ever create it", () => {
    expect(
      partitionMayStillBeCreated(new Date("2026-09-22T23:59:59.999Z"), now),
    ).toBe(false);
    expect(
      partitionMayStillBeCreated(new Date("2026-08-15T06:38:36Z"), now),
    ).toBe(false);
  });
});
