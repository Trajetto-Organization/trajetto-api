import { describe, expect, it } from "vitest";

import {
  diffStatements,
  type StatementCounters,
} from "@/shared/health/pgss-diff";

/**
 * The hourly delta of pg_stat_statements (plano-escala F1-12).
 *
 * The view is cumulative: every counter grows from the last reset, or from
 * when the statement entered the view. One reading says nothing about the
 * last hour; two readings an hour apart do, IF the difference is taken the
 * right way. What this pins:
 *
 *  - with a baseline, a statement's row is the growth of each counter, and
 *    one that did not run in the hour leaves no row;
 *  - after a reset (stats_reset moved) nothing is subtracted: the counters
 *    started over after the baseline, so what the view holds is the delta,
 *    and a reset never produces a negative number;
 *  - a statement the view evicted and took back (pg_stat_statements.max)
 *    shows up with a counter below its baseline: its current counters are
 *    the delta, never a negative one; a statement new in the hour is all
 *    delta too;
 *  - the maximum is the view's own, cumulative since the entry began (PG16
 *    has no per-period maximum to subtract);
 *  - only the top N by execution time in the hour are kept.
 */

let next = 1;

function statement(
  overrides: Partial<StatementCounters> = {},
): StatementCounters {
  return {
    userid: "10",
    toplevel: true,
    queryid: String(next++),
    calls: 100,
    total_exec_time: 1_000,
    total_plan_time: 10,
    max_exec_time: 50,
    rows: 100,
    shared_blks_hit: 1_000,
    shared_blks_read: 10,
    shared_blks_dirtied: 1,
    shared_blks_written: 1,
    temp_blks_written: 0,
    wal_bytes: 4_096,
    ...overrides,
  };
}

/** The same statement, `factor` times further along. */
function grown(base: StatementCounters, factor: number): StatementCounters {
  return {
    ...base,
    calls: base.calls * factor,
    total_exec_time: base.total_exec_time * factor,
    total_plan_time: base.total_plan_time * factor,
    max_exec_time: base.max_exec_time + 5,
    rows: base.rows * factor,
    shared_blks_hit: base.shared_blks_hit * factor,
    shared_blks_read: base.shared_blks_read * factor,
    shared_blks_dirtied: base.shared_blks_dirtied * factor,
    shared_blks_written: base.shared_blks_written * factor,
    temp_blks_written: base.temp_blks_written * factor,
    wal_bytes: base.wal_bytes * factor,
  };
}

describe("the hourly delta of the statements", () => {
  it("is the growth of every counter since the baseline", () => {
    const before = statement();
    const after = grown(before, 3);

    const { top } = diffStatements({
      current: [after],
      baseline: [before],
      reset: false,
      top: 200,
    });

    expect(top).toEqual([
      {
        userid: "10",
        toplevel: true,
        queryid: before.queryid,
        basis: "previous",
        calls: 200,
        total_exec_time: 2_000,
        total_plan_time: 20,
        // Cumulative: PG16 keeps one maximum per entry.
        max_exec_time: 55,
        rows: 200,
        shared_blks_hit: 2_000,
        shared_blks_read: 20,
        shared_blks_dirtied: 2,
        shared_blks_written: 2,
        temp_blks_written: 0,
        wal_bytes: 8_192,
      },
    ]);
  });

  it("leaves out a statement that did not run in the hour", () => {
    const idle = statement();

    expect(
      diffStatements({
        current: [idle],
        baseline: [idle],
        reset: false,
        top: 200,
      }).top,
    ).toEqual([]);
  });

  it("subtracts nothing after a reset, and never goes negative", () => {
    const before = statement({ calls: 5_000, total_exec_time: 90_000 });
    // After the reset, the view started over: less than the baseline.
    const after = statement({
      queryid: before.queryid,
      calls: 40,
      total_exec_time: 400,
    });

    const { top } = diffStatements({
      current: [after],
      baseline: [before],
      reset: true,
      top: 200,
    });

    expect(top).toHaveLength(1);
    expect(top[0]).toMatchObject({
      basis: "reset",
      calls: 40,
      total_exec_time: 400,
    });

    for (const value of Object.values(top[0])) {
      if (typeof value === "number") expect(value).toBeGreaterThanOrEqual(0);
    }
  });

  it("takes an evicted and re-entered statement's counters as the delta", () => {
    const before = statement({ calls: 900, total_exec_time: 9_000 });
    const after = statement({
      queryid: before.queryid,
      calls: 30,
      total_exec_time: 300,
    });

    const result = diffStatements({
      current: [after],
      baseline: [before],
      reset: false,
      top: 200,
    });

    expect(result.top[0]).toMatchObject({
      basis: "recreated",
      calls: 30,
      total_exec_time: 300,
    });
    expect(result.recreated).toBe(1);
  });

  it("calls a re-entry any counter that went backwards, not only calls", () => {
    const before = statement({ calls: 10, rows: 5_000 });
    const after = statement({ queryid: before.queryid, calls: 40, rows: 80 });

    expect(
      diffStatements({
        current: [after],
        baseline: [before],
        reset: false,
        top: 200,
      }).top[0],
    ).toMatchObject({ basis: "recreated", calls: 40, rows: 80 });
  });

  it("takes a statement new in the hour as all delta", () => {
    const fresh = statement({ calls: 7 });

    expect(
      diffStatements({
        current: [fresh],
        baseline: [],
        reset: false,
        top: 200,
      }).top[0],
    ).toMatchObject({ basis: "new", calls: 7 });
  });

  it("counts the statements of the baseline the view no longer has", () => {
    const kept = statement();
    const gone = statement();

    expect(
      diffStatements({
        current: [grown(kept, 2)],
        baseline: [kept, gone],
        reset: false,
        top: 200,
      }).vanished,
    ).toBe(1);
  });

  it("tells statements apart by user and level, not only by queryid", () => {
    const http = statement({ userid: "10", queryid: "42" });
    const worker = statement({ userid: "11", queryid: "42" });
    const nested = statement({ userid: "10", queryid: "42", toplevel: false });

    const { top } = diffStatements({
      current: [grown(http, 2), grown(worker, 3), grown(nested, 4)],
      baseline: [http, worker, nested],
      reset: false,
      top: 200,
    });

    expect(
      top.map(({ userid, toplevel, calls }) => [userid, toplevel, calls]),
    ).toEqual([
      ["10", false, 300],
      ["11", true, 200],
      ["10", true, 100],
    ]);
  });

  it("keeps only the top N by execution time in the hour", () => {
    const statements = Array.from({ length: 5 }, (_, i) =>
      statement({ total_exec_time: 1_000 * (i + 1) }),
    );

    const { top, active } = diffStatements({
      current: statements.map((entry) => grown(entry, 2)),
      baseline: statements,
      reset: false,
      top: 2,
    });

    expect(active).toBe(5);
    expect(top.map((row) => row.total_exec_time)).toEqual([5_000, 4_000]);
  });
});
