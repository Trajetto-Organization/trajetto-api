import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createOutageReport } from "@/shared/logging/outage-report";

/**
 * One line per minute of an outage, and each outage's count in its own lines.
 *
 * The count used to be logged only on a failure: whatever followed the last
 * line of a short outage stayed in memory and was added to the first line of
 * the next one, maybe days later — the number an operator reads to size an
 * outage mixed two of them.
 */
const MINUTE = 60_000;

function reporter() {
  const lines: Array<[number, string | undefined]> = [];

  const report = createOutageReport<string>({
    intervalMs: MINUTE,
    report: (count, detail) => lines.push([count, detail]),
  });

  return { lines, report };
}

describe("createOutageReport", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-10T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("logs the first failure at once", () => {
    const { lines, report } = reporter();

    report.failed(3, "ECONNREFUSED");

    expect(lines).toEqual([[3, "ECONNREFUSED"]]);
    expect(report.unreported()).toBe(0);
  });

  it("logs what follows in one line when the minute ends, with the latest detail", () => {
    const { lines, report } = reporter();

    report.failed(1, "first");
    vi.advanceTimersByTime(10_000);
    report.failed(2, "second");
    vi.advanceTimersByTime(10_000);
    report.failed(4, "third");

    expect(lines).toEqual([[1, "first"]]);
    expect(report.unreported()).toBe(6);

    vi.advanceTimersByTime(40_000);

    expect(lines).toEqual([
      [1, "first"],
      [6, "third"],
    ]);
    expect(report.unreported()).toBe(0);
  });

  it("never adds a short outage's rest to the next outage's first line", () => {
    const { lines, report } = reporter();

    // A short outage: its first line, then two more failures before it ends.
    report.failed(1, "a");
    vi.advanceTimersByTime(5_000);
    report.failed(2, "a");

    // Days of quiet.
    vi.advanceTimersByTime(3 * 24 * 60 * MINUTE);

    report.failed(5, "b");

    expect(lines).toEqual([
      [1, "a"],
      [2, "a"],
      [5, "b"],
    ]);
  });

  it("writes at most one line a minute however many failures arrive", () => {
    const { lines, report } = reporter();

    for (let second = 0; second < 180; second += 1) {
      report.failed(1, "storm");
      vi.advanceTimersByTime(1_000);
    }

    vi.advanceTimersByTime(MINUTE);

    expect(lines.length).toBeLessThanOrEqual(4);
    expect(lines.reduce((sum, [count]) => sum + count, 0)).toBe(180);
  });

  it("logs nothing when nothing failed", () => {
    const { lines } = reporter();

    vi.advanceTimersByTime(10 * MINUTE);

    expect(lines).toEqual([]);
  });
});
