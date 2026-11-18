import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  columnOf,
  fairClaimSql,
  nextFairCursor,
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
    // only the fair index can give.
    expect(text).toContain(
      '"business_id" >= "t"."tenant" AND "business_id" <= "t"."tenant"',
    );
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
    const company =
      '"businessId" >= "t"."tenant" AND "businessId" <= "t"."tenant"';

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
