import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  columnOf,
  fairClaimSql,
  fairWalkOf,
  nextFairCursor,
  walkFairLap,
  type FairQueue,
} from "@/shared/queue/fair-claim";

/**
 * The fair claim's statement (plano-escala F3-10): what it must keep for
 * the planner and for the queue's guarantees, without a database (the
 * E2E queue-fair-claim and query-plans-queues run it for real).
 *
 *  - a recursive skip scan from the cursor, a wrap up to it, and the NULL
 *    bucket between them;
 *  - the index predicate inlined as literals, every bound value with its
 *    cast;
 *  - the claim under FOR UPDATE … SKIP LOCKED, rechecked on the locked row,
 *    with the claim floor on every level;
 *  - nothing but constants as identifiers, and positive limits;
 *  - the cursor: the walk's last company, kept when nothing was claimed.
 */

const queue: FairQueue = {
  table: "notification_delivery",
  tenant: "business_id",
  dueAt: "availableAt",
  indexed: (alias) =>
    Prisma.sql`${columnOf(alias, "status")} IN ('PENDING', 'PROCESSING') AND ${columnOf(alias, "channel")} IN ('EMAIL', 'WHATSAPP')`,
  due: (alias) =>
    Prisma.sql`${columnOf(alias, "availableAt")} <= now() AND ${columnOf(alias, "attempts")} < ${7}::int`,
  set: Prisma.sql`"status" = 'PROCESSING'`,
  returning: `"id"`,
};

const input = {
  cursor: "018fc000-0000-7000-8000-000000000001",
  limit: 5,
  rowsPerTenant: 2,
  maxTenants: 64,
  floor: Prisma.sql` AND "id" >= ${"lo"}`,
  rowFloor: Prisma.sql` AND "row"."id" >= ${"lo"}`,
};

describe("the fair claim's statement", () => {
  const sql = fairClaimSql(queue, input);
  const text = sql.text.replace(/\s+/g, " ");

  it("walks from the cursor, visits the NULL bucket, and wraps up to the cursor", () => {
    expect(text).toContain("WITH RECURSIVE");
    expect(text).toMatch(/"after" \("n", "tenant", "found", "ids"\) AS/);
    expect(text).toMatch(/"before" \("n", "tenant", "found", "ids"\) AS/);
    expect(text).toContain('"business_id" IS NULL');
    expect(text).toContain('"next"."tenant" <= $');
  });

  it("reads a company's rows in the fair index's order, never by company equality", () => {
    // With `business_id = company` the planner drops the company from the
    // order and, when the statistics see few companies, reads the due-time
    // index filtering by company: a small company behind a flood was found
    // after the whole flood (1,168 pages for a claim of five in the plan
    // test, against ~200). A one-value range ordered by (company, due time)
    // only the fair index can give. Now as `= ANY(ARRAY[company])`, which
    // btree reads as an equality key: the scan ends at the company's first
    // row not yet due, instead of reading every row it has in backoff (420
    // pages with twenty thousand webhooks parked, in queue-claim-by-due).
    expect(text).toContain('"business_id" = ANY(ARRAY["t"."tenant"])');
    expect(text).not.toContain('"business_id" <= "t"."tenant"');
    expect(text).toContain('ORDER BY "business_id", "availableAt" LIMIT');
    expect(text).not.toMatch(/"business_id" = "t"\."tenant"/);

    // The NULL bucket, the same order.
    expect(text).toMatch(
      /"business_id" IS NULL AND .*? ORDER BY "business_id", "availableAt"/,
    );

    // Past the last company the walk ends without reading anything more.
    expect(text).toContain('WHERE "t"."tenant" IS NOT NULL');
  });

  it("inlines the index predicate as literals and casts every bound value", () => {
    expect(text).toContain(
      "\"status\" IN ('PENDING', 'PROCESSING') AND \"channel\" IN ('EMAIL', 'WHATSAPP')",
    );

    // No bare placeholder: each one is cast or sits in a comparison whose
    // other side gives it the column's type.
    for (const match of text.matchAll(/\$(\d+)(::\w+)?/g)) {
      const [whole, , cast] = match;
      const before = text.slice(Math.max(0, match.index! - 12), match.index);

      expect(
        cast !== undefined || /(>=|<|=|=>)\s*$/.test(before),
        `${whole} sem tipo: ...${before}${whole}`,
      ).toBe(true);
    }

    expect(sql.values).toContain(input.cursor);
    expect(sql.values).toContain(input.rowsPerTenant);
    expect(sql.values).toContain(input.maxTenants);
    expect(sql.values).toContain(input.limit);
  });

  it("locks what it claims, skipping the rows another process holds, and checks them again", () => {
    expect(text).toContain('FOR UPDATE OF "row" SKIP LOCKED');
    expect(text).toContain(
      'WHERE "row"."status" IN (\'PENDING\', \'PROCESSING\') AND "row"."channel" IN (\'EMAIL\', \'WHATSAPP\') AND "row"."availableAt" <= now()',
    );
    expect(text).toContain('"row"."id" >= $');
    expect(text).toContain(
      'RETURNING "id", (SELECT "tenant" FROM "walk_end") AS "fairCursor"',
    );
  });

  it("puts the claim floor on every read of the table", () => {
    const reads = text.match(/FROM "notification_delivery"/g) ?? [];
    const floors = text.match(/"id" >= \$\d+/g) ?? [];

    // Every read, the UPDATE's own WHERE, and the recheck on "row".
    expect(floors.length).toBeGreaterThanOrEqual(reads.length);
  });

  it("refuses an identifier that is not a constant's spelling", () => {
    expect(() =>
      fairClaimSql({ ...queue, table: 'notification_delivery"; --' }, input),
    ).toThrow(/identificador inválido/);
    expect(() =>
      fairClaimSql({ ...queue, tenant: "business id" }, input),
    ).toThrow(/identificador inválido/);
  });

  it("refuses a limit, a share or a walk that is not a positive integer", () => {
    for (const bad of [
      { limit: 0 },
      { rowsPerTenant: 0 },
      { maxTenants: -1 },
      { limit: 1.5 },
    ]) {
      expect(() => fairClaimSql(queue, { ...input, ...bad })).toThrow(
        /inválido/,
      );
    }
  });
});

/** `value` as a literal inside a RegExp. */
function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("a queue whose rows are not all equally urgent (F3-12)", () => {
  // The AI queue: a receipt is read while the driver is still at the door,
  // so a company's share is its receipts first, through a fair index of
  // their own, and its other kinds only when the receipts ran short.
  const ai: FairQueue = {
    table: "ai_analysis_request",
    tenant: "businessId",
    dueAt: "availableAt",
    indexed: (alias) =>
      Prisma.sql`${columnOf(alias, "status")} IN ('PENDING', 'PROCESSING')`,
    due: (alias) => Prisma.sql`${columnOf(alias, "availableAt")} <= now()`,
    classes: [
      (alias) => Prisma.sql`${columnOf(alias, "type")} = 'DELIVERY_PROOF'`,
      (alias) => Prisma.sql`${columnOf(alias, "type")} <> 'DELIVERY_PROOF'`,
    ],
    set: Prisma.sql`"status" = 'PROCESSING'`,
    returning: `"id"`,
  };

  const text = fairClaimSql(ai, {
    ...input,
    floor: Prisma.empty,
    rowFloor: Prisma.empty,
  }).text.replace(/\s+/g, " ");

  it("reads a company's first class before the next, each by the fair index's order", () => {
    const company = '"businessId" = ANY(ARRAY["t"."tenant"])';

    // The first class is what the company's share starts from…
    expect(text).toMatch(
      new RegExp(
        String.raw`FROM \(SELECT ARRAY\( SELECT "id" FROM "ai_analysis_request" WHERE .*? AND ` +
          escape(company) +
          String.raw` AND "type" = 'DELIVERY_PROOF' AND .*? ORDER BY "businessId", "availableAt" LIMIT \$\d+::int \) AS "ids" OFFSET 0\)`,
      ),
    );

    // …and the next one is appended after it, never before.
    expect(text).toMatch(
      new RegExp(
        String.raw`ELSE \("p"\."ids" \|\| ARRAY\( SELECT "id" FROM "ai_analysis_request" WHERE .*? AND ` +
          escape(company) +
          String.raw` AND "type" <> 'DELIVERY_PROOF' AND .*? ORDER BY "businessId", "availableAt" LIMIT`,
      ),
    );
  });

  it("probes the next class only while the ones before it came back short", () => {
    expect(text).toMatch(
      /WHEN cardinality\("p"\."ids"\) >= \$\d+::int THEN "p"\."ids" ELSE \("p"\."ids" \|\| ARRAY\(/,
    );
    // What the first class found keeps its place at the front, cut at the
    // company's share.
    expect(text).toMatch(/\)\[1:\$\d+::int\] END/);
  });

  it("reads the rows of no company class by class too", () => {
    expect(text).toContain(
      '"businessId" IS NULL AND "type" = \'DELIVERY_PROOF\'',
    );
    expect(text).toContain(
      '"businessId" IS NULL AND "type" <> \'DELIVERY_PROOF\'',
    );
  });

  it("is the one-class statement of before without classes", () => {
    const plain = fairClaimSql(
      { ...ai, classes: undefined },
      { ...input, floor: Prisma.empty, rowFloor: Prisma.empty },
    ).text;

    expect(plain).not.toContain('cardinality("p"');
    expect(plain).not.toContain("DELIVERY_PROOF");
  });
});

describe("a queue whose shares are caps (F3-13)", () => {
  // The webhooks: an endpoint's share is what its global cap leaves, read
  // from the rows in flight counted once per claim, and nothing fills past
  // the shares.
  const capped: FairQueue = {
    table: "webhook_delivery",
    tenant: "endpointId",
    dueAt: "availableAt",
    thenBy: ["id"],
    indexed: (alias) =>
      Prisma.sql`${columnOf(alias, "status")} IN ('PENDING', 'PROCESSING')`,
    due: (alias) => Prisma.sql`${columnOf(alias, "availableAt")} <= now()`,
    with: Prisma.sql`"in_flight" ("endpointId", "busy") AS MATERIALIZED (SELECT 'x', 0)`,
    share: (endpoint) =>
      Prisma.sql`${4}::int - coalesce((SELECT "busy" FROM "in_flight" WHERE "endpointId" = ${endpoint}), 0)`,
    fill: false,
    set: Prisma.sql`"status" = 'PROCESSING'`,
    returning: `"id"`,
  };

  const text = fairClaimSql(capped, {
    ...input,
    floor: Prisma.empty,
    rowFloor: Prisma.empty,
  }).text.replace(/\s+/g, " ");

  it("computes what the shares read once, before the walk", () => {
    expect(text).toMatch(
      /^ ?WITH RECURSIVE "in_flight" \("endpointId", "busy"\) AS MATERIALIZED .*?, "after" \(/,
    );
  });

  it("reads each endpoint's rows up to its share, in the order of the index", () => {
    expect(text).toMatch(
      /ORDER BY "endpointId", "availableAt", "id" LIMIT GREATEST\(0, LEAST\(\$\d+::int, \$\d+::int - coalesce\(\(SELECT "busy" FROM "in_flight" WHERE "endpointId" = "t"\."tenant"\), 0\)\)\)/,
    );
  });

  it("holds an endpoint's rows as it reads them, past the ones another transaction holds", () => {
    // Picked by id and locked only at the end, a share spent on held rows
    // left the endpoint's other rows behind them while they were held.
    expect(text).toMatch(
      /"endpointId" = "t"\."tenant"\), 0\)\)\) FOR UPDATE SKIP LOCKED \)/,
    );
  });

  it("cuts what the endpoints of one group found at the group's room (F3-14)", () => {
    // Two endpoints of one host each take what the host had left, unless
    // the rows found are ranked within the host and cut at its room.
    const grouped = fairClaimSql(
      {
        ...capped,
        groupCap: {
          of: (endpoint) =>
            Prisma.sql`(SELECT "host" FROM "endpoint" WHERE "id" = ${endpoint})`,
          room: (host) =>
            Prisma.sql`${16}::int - coalesce((SELECT "busy" FROM "hosts" WHERE "host" = ${host}), 0)`,
        },
      },
      { ...input, floor: Prisma.empty, rowFloor: Prisma.empty },
    ).text.replace(/\s+/g, " ");

    expect(grouped).toContain(
      'PARTITION BY "g"."group" ORDER BY "c"."pass", "c"."turn", "c"."ord", "c"."id"',
    );
    expect(grouped).toContain(
      'SELECT (SELECT "host" FROM "endpoint" WHERE "id" = "c"."tenant") AS "group"',
    );
    expect(grouped).toMatch(
      /WHERE "ranked"\."group" IS NULL OR "ranked"\."rank" <= \$\d+::int - coalesce\(\(SELECT "busy" FROM "hosts" WHERE "host" = "ranked"\."group"\), 0\)/,
    );
    expect(grouped).toContain('JOIN "admitted" AS "candidates"');

    // Without it, the candidates go straight to the lock.
    expect(text).toContain('JOIN "candidates" AS "candidates"');
    expect(text).not.toContain('"admitted"');
  });

  it("takes nothing outside the walk", () => {
    expect(text).toContain(
      '"oldest" ("id", "ord") AS ( SELECT NULL::text, NULL::bigint WHERE false )',
    );
  });
});

describe("the cursor", () => {
  it("moves to the last company the walk visited", () => {
    expect(
      nextFairCursor([{ fairCursor: "b" }, { fairCursor: "b" }], "a"),
    ).toBe("b");
  });

  it("starts over when the walk visited none", () => {
    expect(nextFairCursor([{ fairCursor: "" }], "a")).toBe("");
    expect(nextFairCursor([{ fairCursor: null }], "a")).toBe("");
  });

  it("stays when nothing was claimed", () => {
    expect(nextFairCursor([], "a")).toBe("a");
  });
});

describe("a queue whose walk comes back with an empty claim (F3-13 review)", () => {
  // The webhooks have no fill behind their shares: a walk that met only
  // endpoints with nothing to take (parked, in backoff, at a cap) returned
  // no row, so the cursor never moved and every claim walked the same 64
  // endpoints. The walk now comes back even then, with whether its visit
  // bound cut it short.
  const reporting: FairQueue = {
    table: "webhook_delivery",
    tenant: "endpointId",
    dueAt: "availableAt",
    indexed: (alias) =>
      Prisma.sql`${columnOf(alias, "status")} IN ('PENDING', 'PROCESSING')`,
    due: (alias) => Prisma.sql`${columnOf(alias, "availableAt")} <= now()`,
    share: () => Prisma.sql`${2}::int`,
    fill: false,
    reportsWalk: true,
    set: Prisma.sql`"status" = 'PROCESSING'`,
    returning: `"id", "endpointId"`,
  };

  const plain = { ...input, floor: Prisma.empty, rowFloor: Prisma.empty };
  const flat = (sql: Prisma.Sql) => sql.text.replace(/\s+/g, " ");

  it("returns the walk's row joined to what it claimed, never no row", () => {
    const text = flat(fairClaimSql(reporting, plain));

    expect(text).toContain('"claimed" AS ( UPDATE "webhook_delivery" SET');
    expect(text).toContain('RETURNING "id", "endpointId" )');
    expect(text).toContain(
      'SELECT "claimed".*, "walk_end"."tenant" AS "fairCursor", "walk_end"."cut" AS "fairCut", "walk_end"."wrapped" AS "fairWrapped" FROM "walk_end" LEFT JOIN "claimed" ON true',
    );

    // The queues that fill keep the statement of before.
    expect(flat(fairClaimSql(queue, input))).not.toContain('"claimed" AS (');
  });

  it("says when a visit bound stopped the walk, and when it ended in the wrap", () => {
    const text = flat(fairClaimSql(reporting, plain));

    expect(text).toMatch(
      /"walk_end" \("tenant", "cut", "wrapped"\) AS \( SELECT coalesce\(.*?\), \(SELECT "n" FROM "after_end"\) >= \$\d+::int OR coalesce\(\(SELECT max\("n"\) FROM "before"\), 0\) >= \$\d+::int, EXISTS \(SELECT 1 FROM "before"\) \)/,
    );
  });

  it("wraps up to the lap's end, which is the cursor unless given", () => {
    const own = fairClaimSql(reporting, plain);
    const lap = fairClaimSql(reporting, { ...plain, lapEnd: "lap-start" });

    expect(own.values).not.toContain("lap-start");
    expect(lap.values).toContain("lap-start");
    expect(lap.values).toContain(input.cursor);

    // Each step of the wrap is bound by the lap's end.
    const bounds = [
      ...flat(lap).matchAll(/"(?:first|next)"\."tenant" <= \$(\d+)/g),
    ];

    expect(bounds).toHaveLength(2);

    for (const [, placeholder] of bounds) {
      expect(lap.values[Number(placeholder) - 1]).toBe("lap-start");
    }
  });

  it("past the last company, walks only up to the lap's end, without the NULL bucket or the wrap", () => {
    const text = flat(
      fairClaimSql(reporting, { ...plain, lapEnd: "lap-start", wrapped: true }),
    );

    expect(text).toMatch(
      /WHERE "first"\."tenant" IS NOT NULL AND "first"\."tenant" <= \$\d+::text UNION ALL/,
    );
    expect(text).toMatch(
      /WHERE "next"\."tenant" IS NOT NULL AND "next"\."tenant" <= \$\d+::text AND "after"\."n" </,
    );
    expect(text).toMatch(/"after_end"\."n" < \$\d+::int AND false THEN/);
    expect(text).toMatch(/<> '' AND false \) AS "first"/);

    // Not past it: the walk from the cursor is unbounded, and the bucket
    // and the wrap are read.
    const open = flat(fairClaimSql(reporting, { ...plain, lapEnd: "x" }));

    expect(open).toMatch(/"after_end"\."n" < \$\d+::int AND true THEN/);
    expect(open).toMatch(/<> '' AND true \) AS "first"/);
    expect(open).toMatch(
      /AS "first" WHERE "first"\."tenant" IS NOT NULL UNION ALL/,
    );
  });
});

describe("the walk read back (fairWalkOf)", () => {
  it("is the walk alone when nothing was claimed", () => {
    expect(
      fairWalkOf([
        {
          id: null,
          endpointId: null,
          fairCursor: "e-64",
          fairCut: true,
          fairWrapped: false,
        },
      ]),
    ).toEqual({ rows: [], cursor: "e-64", cut: true, wrapped: false });
  });

  it("keeps the claimed rows without the walk's columns", () => {
    const walk = fairWalkOf([
      {
        id: "r1",
        endpointId: "e-7",
        fairCursor: "e-9",
        fairCut: false,
        fairWrapped: true,
      },
      {
        id: "r2",
        endpointId: "e-9",
        fairCursor: "e-9",
        fairCut: false,
        fairWrapped: true,
      },
    ]);

    expect(walk.rows).toEqual([
      { id: "r1", endpointId: "e-7" },
      { id: "r2", endpointId: "e-9" },
    ]);
    expect(walk).toMatchObject({ cursor: "e-9", cut: false, wrapped: true });
  });

  it("starts over when there is nothing to read", () => {
    expect(fairWalkOf([])).toEqual({
      rows: [],
      cursor: "",
      cut: false,
      wrapped: false,
    });
  });
});

describe("a lap of walks (walkFairLap)", () => {
  /**
   * The statement's walk over `companies` (sorted, as the index orders
   * them), with a visit bound of `bound` and a claim of one row: from the
   * cursor up (only up to lapEnd once wrapped), then, short of the bound
   * and not wrapped yet, the wrap from the first company up to lapEnd.
   */
  function circle(companies: string[], claimable: Set<string>, bound = 3) {
    const visits: string[][] = [];

    const walk = async (at: {
      cursor: string;
      lapEnd: string;
      wrapped: boolean;
    }) => {
      const seen: string[] = [];

      // Visits up to `bound` of `pool`: the first claimable one, or none.
      const visit = (pool: string[]) => {
        for (const company of pool.slice(0, bound)) {
          seen.push(company);

          if (claimable.has(company)) return { found: company, cut: false };
        }

        return { found: null, cut: pool.length >= bound };
      };

      const after = visit(
        companies.filter(
          (company) =>
            company > at.cursor && (!at.wrapped || company <= at.lapEnd),
        ),
      );

      let { found, cut } = after;
      let endedInWrap = false;

      if (found === null && !cut && !at.wrapped && at.lapEnd !== "") {
        const visitedBefore = seen.length;
        const before = visit(
          companies.filter((company) => company <= at.lapEnd),
        );

        found = before.found;
        cut = before.cut;
        endedInWrap = seen.length > visitedBefore;
      }

      visits.push(seen);

      return {
        rows: found ? [found] : [],
        cursor: seen[seen.length - 1] ?? "",
        cut,
        wrapped: endedInWrap,
      };
    };

    return { walk, visits };
  }

  const companies = Array.from(
    { length: 10 },
    (_, n) => `c${String(n).padStart(2, "0")}`,
  );

  it("walks on past companies with nothing to take until it claims", async () => {
    const { walk, visits } = circle(companies, new Set(["c08"]));

    const lap = await walkFairLap({ cursor: "", maxWalks: 64, walk });

    expect(lap).toEqual({ rows: ["c08"], cursor: "c08", walks: 3 });
    expect(visits.flat()).toEqual(companies.slice(0, 9));
  });

  it("reaches, past the wrap, a company before the cursor it started from", async () => {
    const { walk, visits } = circle(companies, new Set(["c05"]));

    const lap = await walkFairLap({ cursor: "c06", maxWalks: 64, walk });

    expect(lap.rows).toEqual(["c05"]);
    expect(visits).toEqual([
      ["c07", "c08", "c09"],
      ["c00", "c01", "c02"],
      ["c03", "c04", "c05"],
    ]);
  });

  it("closes the lap at the cursor it started from when nothing is claimable", async () => {
    const { walk, visits } = circle(companies, new Set());
    const heard: string[] = [];

    const lap = await walkFairLap({
      cursor: "c06",
      maxWalks: 64,
      walk,
      onCursor: (cursor) => heard.push(cursor),
    });

    // Every company once, in order from the cursor, and no walk more.
    expect(visits.flat()).toEqual([
      "c07",
      "c08",
      "c09",
      "c00",
      "c01",
      "c02",
      "c03",
      "c04",
      "c05",
      "c06",
    ]);
    expect(lap).toEqual({ rows: [], cursor: "c06", walks: 4 });
    expect(heard).toEqual(["c09", "c02", "c05", "c06"]);
  });

  it("stops at its walks and leaves the rest of the lap to the next claim", async () => {
    const { walk } = circle(companies, new Set(["c09"]));

    const lap = await walkFairLap({ cursor: "", maxWalks: 2, walk });

    expect(lap).toEqual({ rows: [], cursor: "c05", walks: 2 });

    // The next claim starts where this one stopped.
    const next = await walkFairLap({ cursor: lap.cursor, maxWalks: 2, walk });

    expect(next.rows).toEqual(["c09"]);
  });
});
