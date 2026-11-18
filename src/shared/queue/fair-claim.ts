import { Prisma } from "@prisma/client";

/**
 * The fair claim of a queue: company by company, from a rotating cursor
 * (plano-escala F3-10).
 *
 * The claims took the oldest due rows of the whole queue. A carrier that
 * fires twenty thousand notices at once put every other company's message
 * behind them: the twenty thousand went first, one claim after the other,
 * and a small tenant's e-mail waited for the flood to drain. This claim
 * walks the companies that have rows in the queue instead, in the order of
 * their ids, starting after the company where this process's previous
 * claim stopped (the cursor), and takes at most `rowsPerTenant` due rows of
 * each, oldest first, until it has `limit` rows or has visited `maxTenants`
 * companies. Past the last company it visits the rows of no company (the
 * NULL bucket: the platform's own events, rows from before the column), and
 * then wraps to the first company, up to the cursor. What the walk did not
 * fill, the oldest due rows of the queue fill (the claim of before), so a
 * queue with one busy company still claims full batches.
 *
 * How the walk stays cheap with thousands of companies and one with a
 * hundred thousand rows: a recursive CTE that is a skip scan of the queue's
 * fair index, `(<tenant>, <due time>)` with the claim's predicate. Each
 * step finds the next company with one probe (`<tenant> > previous ORDER BY
 * <tenant> LIMIT 1`) and takes the ids of at most `rowsPerTenant` of its due
 * rows with another (`<tenant> = it AND due ORDER BY <due time>`), carried
 * by the walk, so a company costs two short index probes, never a read of
 * its rows. The walk stops at `limit` rows found, so a claim of five visits
 * about three companies; the NULL bucket and the wrap are read only when
 * the walk before them came back short.
 *
 * Literals and casts on purpose: the index predicate is inlined as the
 * constants it is (with bound values the planner cannot prove a partial
 * index in a generic plan), and every bound value carries its type.
 *
 * Every RETURNING row carries `fairCursor`: the last company the walk
 * visited, where the next claim of this process starts. A claim that
 * returns nothing leaves the cursor where it was.
 */

/** A queue the fair claim can walk: constants of the code, never input. */
interface FairQueue {
  /** The table. */
  table: string;

  /** The company column; NULL is the platform's bucket. */
  tenant: string;

  /** The due-time column, the fair index's second key. */
  dueAt: string;

  /**
   * The fair index's predicate, on `alias` (or unqualified), as literals:
   * the claimable statuses and, for a lane, its channels.
   */
  indexed: (alias: string | null) => Prisma.Sql;

  /** The rows a claim may take, on `alias` (or unqualified). */
  due: (alias: string | null) => Prisma.Sql;

  /** What the claim writes. */
  set: Prisma.Sql;

  /** The RETURNING columns, besides `fairCursor`. */
  returning: string;
}

interface FairClaimInput {
  /** The company after which the walk starts; '' starts at the first. */
  cursor: string;
  limit: number;
  rowsPerTenant: number;
  maxTenants: number;

  /** The claim floor (queue-claim-floor.ts), unqualified, or nothing. */
  floor: Prisma.Sql;

  /** The same floor on the alias "row". */
  rowFloor: Prisma.Sql;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function quoted(name: string): Prisma.Sql {
  if (!IDENTIFIER.test(name)) {
    throw new Error(`fairClaimSql: identificador inválido "${name}"`);
  }

  return Prisma.raw(`"${name}"`);
}

/** The column `name` of `alias`, or unqualified. */
function columnOf(alias: string | null, name: string): Prisma.Sql {
  return alias === null
    ? quoted(name)
    : Prisma.sql`${quoted(alias)}.${quoted(name)}`;
}

/**
 * The fair claim's UPDATE … RETURNING for `queue` (see the top of the
 * file). `limit` rows at most, `rowsPerTenant` of one company in the walk
 * and `maxTenants` companies visited, each way.
 */
function fairClaimSql(queue: FairQueue, input: FairClaimInput): Prisma.Sql {
  for (const [name, value] of [
    ["limit", input.limit],
    ["rowsPerTenant", input.rowsPerTenant],
    ["maxTenants", input.maxTenants],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`fairClaimSql: ${name} inválido (${value})`);
    }
  }

  const table = quoted(queue.table);
  const tenant = quoted(queue.tenant);
  const dueAt = quoted(queue.dueAt);
  const indexed = queue.indexed(null);
  const due = queue.due(null);
  const { floor } = input;

  const perTenant = Prisma.sql`${input.rowsPerTenant}::int`;
  const maxTenants = Prisma.sql`${input.maxTenants}::int`;
  const limit = Prisma.sql`${input.limit}::int`;
  const cursor = Prisma.sql`${input.cursor}::text`;

  // The NULL bucket's turn: after every company past the cursor.
  const nullTurn = Prisma.sql`${input.maxTenants + 1}::int`;

  /** One probe: the first company past `previous` with rows in the index. */
  const nextTenant = (previous: Prisma.Sql) => Prisma.sql`(
        SELECT ${tenant} FROM ${table}
        WHERE ${indexed} AND ${tenant} > ${previous}${floor}
        ORDER BY ${tenant} LIMIT 1
      )`;

  /**
   * One probe: the ids of up to rowsPerTenant due rows of `company`, oldest
   * first. Carried by the walk, so a company is read once.
   */
  //
  // The company as a range of one value, ordered by (company, due time), on
  // purpose: with `= company` the planner drops the company from the order
  // and may read the queue's due-time index instead, filtering by company.
  // It does so when the statistics see few companies (a young table, one
  // carrier alone) — and then a small company behind a flood is found
  // after the whole flood. Only the fair index gives this order.
  const dueIdsOf = (company: Prisma.Sql) => Prisma.sql`ARRAY(
        SELECT "id" FROM ${table}
        WHERE ${indexed}
          AND ${tenant} >= ${company} AND ${tenant} <= ${company}
          AND ${due}${floor}
        ORDER BY ${tenant}, ${dueAt}
        LIMIT ${perTenant}
      )`;

  /**
   * The step of a walk: the company after `previous`, and its due ids, read
   * only when there is a company (past the last one, the walk ends).
   */
  const step = (previous: Prisma.Sql) => Prisma.sql`(
        SELECT "t"."tenant", ${dueIdsOf(Prisma.raw(`"t"."tenant"`))} AS "ids"
        FROM (SELECT ${nextTenant(previous)} AS "tenant" OFFSET 0) AS "t"
        WHERE "t"."tenant" IS NOT NULL
        OFFSET 0
      )`;

  return Prisma.sql`
    WITH RECURSIVE
    "after" ("n", "tenant", "found", "ids") AS (
      SELECT 1, "first"."tenant", cardinality("first"."ids"), "first"."ids"
      FROM ${step(cursor)} AS "first"
      WHERE "first"."tenant" IS NOT NULL
      UNION ALL
      SELECT "after"."n" + 1, "next"."tenant",
             "after"."found" + cardinality("next"."ids"), "next"."ids"
      FROM "after"
      CROSS JOIN LATERAL ${step(Prisma.raw(`"after"."tenant"`))} AS "next"
      WHERE "next"."tenant" IS NOT NULL
        AND "after"."n" < ${maxTenants}
        AND "after"."found" < ${limit}
    ),
    "after_end" ("n", "found") AS (
      SELECT coalesce(max("n"), 0), coalesce(max("found"), 0) FROM "after"
    ),
    -- The rows of no company, once the walk ran past the last company short
    -- of the limit (not when it stopped at the limit or at maxTenants).
    "nulls" ("ids") AS (
      SELECT CASE
        WHEN "after_end"."found" < ${limit} AND "after_end"."n" < ${maxTenants}
        THEN ARRAY(
          SELECT "id" FROM ${table}
          WHERE ${indexed} AND ${tenant} IS NULL AND ${due}${floor}
          ORDER BY ${tenant}, ${dueAt}
          LIMIT ${perTenant}
        )
        ELSE ARRAY[]::text[]
      END
      FROM "after_end"
    ),
    -- The wrap: from the first company up to the cursor, only when what
    -- came before it is still short of the limit.
    "before" ("n", "tenant", "found", "ids") AS (
      SELECT 1, "first"."tenant",
             "base"."found" + cardinality("first"."ids"), "first"."ids"
      FROM (
        SELECT "after_end"."found" + cardinality("nulls"."ids") AS "found",
               "after_end"."n" AS "visited"
        FROM "after_end", "nulls"
        OFFSET 0
      ) AS "base"
      CROSS JOIN LATERAL (
        SELECT "s"."tenant", "s"."ids" FROM ${step(Prisma.sql`${""}::text`)} AS "s"
        WHERE "base"."found" < ${limit}
          AND "base"."visited" < ${maxTenants}
          AND ${cursor} <> ''
      ) AS "first"
      WHERE "first"."tenant" IS NOT NULL
        AND "first"."tenant" <= ${cursor}
      UNION ALL
      SELECT "before"."n" + 1, "next"."tenant",
             "before"."found" + cardinality("next"."ids"), "next"."ids"
      FROM "before"
      CROSS JOIN LATERAL ${step(Prisma.raw(`"before"."tenant"`))} AS "next"
      WHERE "next"."tenant" IS NOT NULL
        AND "next"."tenant" <= ${cursor}
        AND "before"."n" < ${maxTenants}
        AND "before"."found" < ${limit}
    ),
    "fair" ("id", "turn", "ord") AS (
      SELECT "row"."id", "visits"."turn", "row"."ord"
      FROM (
        SELECT "n" AS "turn", "ids" FROM "after"
        UNION ALL
        SELECT ${nullTurn}, "ids" FROM "nulls"
        UNION ALL
        SELECT ${nullTurn} + "n", "ids" FROM "before"
      ) AS "visits"
      CROSS JOIN LATERAL unnest("visits"."ids") WITH ORDINALITY AS "row" ("id", "ord")
    ),
    "oldest" ("id", "ord") AS (
      SELECT "id", row_number() OVER (ORDER BY ${dueAt}) FROM (
        SELECT "id", ${dueAt} FROM ${table}
        WHERE ${indexed} AND ${due}${floor}
        ORDER BY ${dueAt}
        LIMIT ${limit}
      ) AS "head"
    ),
    "candidates" ("id", "pass", "turn", "ord") AS (
      SELECT DISTINCT ON ("id") "id", "pass", "turn", "ord" FROM (
        SELECT "id", 0 AS "pass", "turn", "ord" FROM "fair"
        UNION ALL
        SELECT "id", 1, 0, "ord" FROM "oldest"
      ) AS "both"
      ORDER BY "id", "pass"
    ),
    "walk_end" ("tenant") AS (
      SELECT coalesce(
        (SELECT "tenant" FROM "before" ORDER BY "n" DESC LIMIT 1),
        (SELECT "tenant" FROM "after" ORDER BY "n" DESC LIMIT 1),
        ''
      )
    )
    UPDATE ${table} SET ${queue.set}
    WHERE "id" IN (
      SELECT "row"."id" FROM ${table} AS "row"
      JOIN "candidates" ON "candidates"."id" = "row"."id"
      -- Checked again under the lock: another process may have taken it.
      WHERE ${queue.indexed("row")} AND ${queue.due("row")}${input.rowFloor}
      ORDER BY "candidates"."pass", "candidates"."turn",
               "candidates"."ord", "row"."id"
      LIMIT ${limit}
      FOR UPDATE OF "row" SKIP LOCKED
    )${floor}
    RETURNING ${Prisma.raw(queue.returning)},
              (SELECT "tenant" FROM "walk_end") AS "fairCursor"
  `;
}

/**
 * Where the next claim of this process starts: the last company the walk
 * visited, carried by every row; nothing claimed keeps the cursor.
 */
function nextFairCursor(
  rows: ReadonlyArray<{ fairCursor?: string | null }>,
  current: string,
): string {
  if (rows.length === 0) return current;

  return rows[0].fairCursor ?? "";
}

export { columnOf, fairClaimSql, nextFairCursor };
export type { FairClaimInput, FairQueue };
