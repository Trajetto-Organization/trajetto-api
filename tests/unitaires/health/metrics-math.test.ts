import { describe, expect, it } from "vitest";

import {
  connectionUsagePercent,
  deadTuplePercent,
} from "@/shared/health/metrics-math";

/**
 * Two ratios that decide when somebody is told to act.
 *
 * Connection usage drives a badge that reads "Atenção" at 70 and "Crítico" at
 * 90; dead tuples drive the agreed trigger to vacuum at 20. Neither of them
 * looks broken when it is wrong — an inverted ratio shows an idle database in
 * red and a database about to refuse connections in green, and nobody
 * double-checks a green.
 *
 * Tested here rather than through the endpoint because the INPUTS are the hard
 * part: three hundred rows deleted from a queue table are vacuumed away before
 * a request can read them, so an end-to-end check of the formula ends up
 * measuring zero against zero. The endpoint's own test still asserts that what
 * it publishes agrees with the rows it reports.
 */
describe("how full the connection pool is", () => {
  it("answers usage, not headroom", () => {
    expect(connectionUsagePercent(90, 100)).toBe(90);
  });

  it("is zero on an idle database, not a hundred", () => {
    // The inversion in one line: headroom would say 100 here and 10 above.
    expect(connectionUsagePercent(0, 100)).toBe(0);
  });

  it("rounds to the nearest whole percent", () => {
    expect(connectionUsagePercent(1, 3)).toBe(33);
    expect(connectionUsagePercent(2, 3)).toBe(67);
  });

  it("and says zero rather than dividing by nothing", () => {
    /**
     * `max_connections` arrives as text from `current_setting` and becomes 0
     * if the read ever fails. A NaN on this panel would render as "NaN%" next
     * to a green badge, which is worse than a wrong number: it is a number
     * nobody can act on.
     */
    expect(connectionUsagePercent(5, 0)).toBe(0);
    expect(connectionUsagePercent(0, 0)).toBe(0);
  });

  it("and crosses its thresholds where the badge says it does", () => {
    // 70 is where PgBouncer starts paying for itself; 90 is the cliff.
    expect(connectionUsagePercent(69, 100)).toBeLessThan(70);
    expect(connectionUsagePercent(70, 100)).toBe(70);

    expect(connectionUsagePercent(89, 100)).toBeLessThan(90);
    expect(connectionUsagePercent(90, 100)).toBe(90);
  });
});

describe("how bloated a queue table is", () => {
  it("measures dead rows against the whole table", () => {
    expect(deadTuplePercent(100, 900)).toBe(90);
  });

  it("and not against the live ones", () => {
    /**
     * The mutation that survived an end-to-end check: with no dead rows both
     * formulas answer zero, so the two only disagree in the case the threshold
     * exists for. Against the live rows this same table reads 900%.
     */
    expect(deadTuplePercent(100, 900)).not.toBe(900);
  });

  it("copes with a table that is entirely dead", () => {
    // Every row deleted and nothing vacuumed yet: 100% bloat, not a division
    // by zero.
    expect(deadTuplePercent(0, 500)).toBe(100);
  });

  it("and with one that is empty", () => {
    expect(deadTuplePercent(0, 0)).toBe(0);
  });

  it("and crosses the vacuum trigger where it should", () => {
    // 20% is the agreed point to act.
    expect(deadTuplePercent(81, 19)).toBeLessThan(20);
    expect(deadTuplePercent(80, 20)).toBe(20);
  });
});
