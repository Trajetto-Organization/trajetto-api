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
