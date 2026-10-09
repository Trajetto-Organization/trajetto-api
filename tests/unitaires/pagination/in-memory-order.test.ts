import { describe, expect, it } from "vitest";

import {
  compareForOrder,
  type NullsPlacement,
} from "@/shared/pagination/in-memory-order";
import type { SortOrder } from "@/shared/pagination/list-query";

/**
 * The twins' comparator follows Postgres (decision 8.8, table-infra-result
 * §4.3). The same placements are checked against the real database in
 * tests/E2E/list-order-nulls.test.ts, so a twin that uses this function
 * orders like the Prisma repository it stands in for.
 */
type Value = string | number | boolean | Date | null;

function ordered(values: Value[], order: SortOrder, nulls?: NullsPlacement): Value[] {
  return [...values].sort((a, b) => compareForOrder(a, b, order, nulls));
}

describe("compareForOrder", () => {
  it("orders strings, numbers and dates both ways", () => {
    expect(ordered(["b", "a", "c"], "asc")).toEqual(["a", "b", "c"]);
    expect(ordered([2, 10, 1], "desc")).toEqual([10, 2, 1]);

    const early = new Date("2026-09-01T00:00:00Z");
    const late = new Date("2026-09-02T00:00:00Z");

    expect(ordered([late, early], "asc")).toEqual([early, late]);
  });

  it("puts false before true, as Postgres orders booleans", () => {
    expect(ordered([true, false], "asc")).toEqual([false, true]);
    expect(ordered([false, true], "desc")).toEqual([true, false]);
  });

  it("treats NULL as the largest value by default: last on asc, first on desc", () => {
    expect(ordered(["b", null, "a"], "asc")).toEqual(["a", "b", null]);
    expect(ordered(["b", null, "a"], "desc")).toEqual([null, "b", "a"]);
  });

  it("keeps NULLs where { nulls } puts them, in both directions", () => {
    expect(ordered(["b", null, "a"], "asc", "last")).toEqual(["a", "b", null]);
    expect(ordered(["b", null, "a"], "desc", "last")).toEqual(["b", "a", null]);
    expect(ordered(["b", null, "a"], "asc", "first")).toEqual([null, "a", "b"]);
    expect(ordered(["b", null, "a"], "desc", "first")).toEqual([null, "b", "a"]);
  });

  it("reads undefined as NULL and two NULLs as a tie", () => {
    expect(compareForOrder(undefined, null, "asc")).toBe(0);
    expect(compareForOrder(undefined, "a", "asc")).toBeGreaterThan(0);
  });
  /**
   * Postgres on the deployed image (musl, en_US.utf8) orders by code point.
   * JS `<` compares UTF-16 units, which puts an emoji (a surrogate pair,
   * 0xD83D…) before "Ａ" (U+FF21); by code point U+1F600 comes after it.
   */
  it("orders strings by code point, like Postgres on the deployed image", () => {
    expect(ordered(["😀", "Ａ", "Ágata", "ana", "Ana", "ANA"], "asc")).toEqual([
      "ANA",
      "Ana",
      "ana",
      "Ágata",
      "Ａ",
      "😀",
    ]);
  });
});
