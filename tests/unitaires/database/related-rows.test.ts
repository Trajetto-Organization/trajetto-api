import { describe, expect, it } from "vitest";

import {
  groupedBy,
  relatedTo,
  rowsByKey,
} from "@/shared/database/related-rows";

/**
 * Relations read the way Prisma 6 read an include.
 *
 * Prisma 7 queries an include's relation even when no parent row has the key
 * (`= NULL`, `IN (NULL)`). The hot reads load those relations through these
 * helpers instead, and the point of them is the query that does NOT happen:
 * no keys, no lookup — and, when there are keys, one lookup for the distinct
 * ones, with the include's answer (the row, or null) for each parent.
 */
function recorder<Row>(rows: Row[]) {
  const calls: string[][] = [];

  return {
    calls,
    load: async (keys: string[]) => {
      calls.push(keys);

      return rows;
    },
  };
}

describe("rowsByKey", () => {
  it("does not query when no row carries the key", async () => {
    const { calls, load } = recorder([{ id: "v1" }]);

    const rows = await rowsByKey([null, undefined, null], load);

    expect(calls).toEqual([]);
    expect(rows.size).toBe(0);
  });

  it("does not query for an empty list of parents", async () => {
    const { calls, load } = recorder([{ id: "v1" }]);

    await rowsByKey([], load);

    expect(calls).toEqual([]);
  });

  it("asks once, for the distinct keys present", async () => {
    const { calls, load } = recorder([{ id: "a" }, { id: "b" }]);

    const rows = await rowsByKey(["a", null, "b", "a"], load);

    expect(calls).toEqual([["a", "b"]]);
    expect([...rows.keys()]).toEqual(["a", "b"]);
  });

  it("keys the rows by another column when told to", async () => {
    const { load } = recorder([{ id: "u1", driverId: "d1" }]);

    const rows = await rowsByKey(["d1"], load, (row) => row.driverId);

    expect(rows.get("d1")).toEqual({ id: "u1", driverId: "d1" });
  });
});

describe("relatedTo", () => {
  const rows = new Map([["a", { id: "a", name: "A" }]]);

  it("gives the row the key names", () => {
    expect(relatedTo(rows, "a")).toEqual({ id: "a", name: "A" });
  });

  it("gives null for a null key, as the include did", () => {
    expect(relatedTo(rows, null)).toBeNull();
    expect(relatedTo(rows, undefined)).toBeNull();
  });

  it("gives null for a key with no row", () => {
    expect(relatedTo(rows, "gone")).toBeNull();
  });
});

describe("groupedBy", () => {
  it("puts a flat read back under its parents, in the order it was read", () => {
    const stops = [
      { routeId: "r2", sequence: 1 },
      { routeId: "r1", sequence: 1 },
      { routeId: "r2", sequence: 2 },
      { routeId: "r1", sequence: 2 },
    ];

    const groups = groupedBy(stops, (stop) => stop.routeId);

    expect(groups.get("r1")?.map((stop) => stop.sequence)).toEqual([1, 2]);
    expect(groups.get("r2")?.map((stop) => stop.sequence)).toEqual([1, 2]);
    expect(groups.get("r3")).toBeUndefined();
  });
});
