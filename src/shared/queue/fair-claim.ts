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
 * returns nothing leaves the cursor where it was, except in a queue that
 * `reportsWalk`, whose walk comes back even when it claimed nothing.
 *
 * A queue whose shares are caps (the webhooks, F3-13) has no fill behind
 * the walk, so a walk that met only companies with nothing it could take
 * (rows parked for a paused endpoint, rows in backoff or in flight, a cap
 * reached) must not end the search there: the queue `reportsWalk`, the
 * walk's end comes back with whether its visit bound cut it short, and
 * the caller walks on from there (walkFairLap) until the lap closes at
 * the cursor it started from. A cursor that stayed put after an empty
 * claim sent every claim through the same companies, and the ones after
 * them were never reached.
 *
 * A queue whose rows are not all equally urgent names `classes` (the AI
 * queue: the receipt before the refuelling and the checklist, F3-12): a
 * company's share is read class by class, each through a partial fair
 * index of its own, and a class is probed only while the ones before it
 * came back short, so the urgent class costs the same two probes and the
 * others one more only when it ran out.
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

  /**
   * A company's rows in order of priority (plano-escala F3-12), each a
   * predicate on `alias` (or unqualified) with a fair index of its own:
   * the walk reads a company's due rows of the first class, and those of
   * the next only while the classes before it came back short of
   * rowsPerTenant. Absent, one class: every row of the company, by due
   * time.
   */
  classes?: ReadonlyArray<(alias: string | null) => Prisma.Sql>;

  /**
   * Keys of the fair index after the due time, the order of a company's
   * rows that share one (plano-escala F3-13: a webhook endpoint's, by
   * "id", the order of one transaction's rows). Absent, the due time.
   */
  thenBy?: readonly string[];

  /**
   * How many of a company's due rows one claim may take, an integer SQL
   * expression on `company`, never above rowsPerTenant (F3-13: what a
   * webhook endpoint's global cap leaves). Absent, rowsPerTenant.
   *
   * A queue with shares locks a company's rows as the walk reads them,
   * skipping the ones another transaction holds: picked by id and locked
   * only at the end, a share spent on rows somebody else held would leave
   * the company's other rows behind them for as long as they were held.
   * The walk then counts only rows it holds, and the claim takes them.
   * Such a queue has no rows of no company (the NULL bucket has no share).
   */
  share?: (company: Prisma.Sql) => Prisma.Sql;

  /**
   * Whether the oldest due rows of the queue fill what the walk did not
   * (the default). A queue whose shares are caps turns it off (F3-13):
   * the fill would take past them.
   */
  fill?: boolean;

  /**
   * Common table expressions the shares read, computed once per claim
   * before the walk (F3-13: the rows in flight), as `"name" (...) AS (...)`
   * separated by commas.
   */
  with?: Prisma.Sql;

  /**
   * A cap over groups of companies (plano-escala F3-14: the webhook
   * endpoints of one destination host). The walk's shares are per company,
   * so two companies of one group could each take what the group has left;
   * the rows found are ranked within their company's group, in the claim's
   * order, and those past the group's room are left out. `of` gives a
   * company's group (NULL: no group, no cap), `room` what a group may still
   * take.
   */
  groupCap?: {
    of: (company: Prisma.Sql) => Prisma.Sql;
    room: (group: Prisma.Sql) => Prisma.Sql;
  };

  /**
   * The walk comes back even when the claim takes nothing (a queue whose
   * shares are caps, F3-13): one row per claimed row, or one row with the
   * claimed columns null when none was, each with `fairCursor` (the
   * walk's end), `fairCut` (a visit bound stopped it before the lap's end)
   * and `fairWrapped` (it ended in the wrap, past the last company). Read
   * with fairWalkOf. The queue's RETURNING must include "id".
   */
  reportsWalk?: boolean;

  /** What the claim writes. */
  set: Prisma.Sql;

  /** The RETURNING columns, besides `fairCursor`. */
  returning: string;
}

interface FairClaimInput {
  /** The company after which the walk starts; '' starts at the first. */
  cursor: string;

  /**
   * The company where the lap ends, inclusive (walkFairLap): the cursor of
   * the walk that started the lap. Absent, the cursor itself: one whole
   * lap.
   */
  lapEnd?: string;

  /**
   * The lap already went past the last company (an earlier walk of it
   * ended in the wrap): this walk goes from the cursor up to lapEnd only,
   * with no rows of no company and no wrap.
   */
  wrapped?: boolean;

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
  const lapEnd = Prisma.sql`${input.lapEnd ?? input.cursor}::text`;

  // Past the last company already (see `wrapped`): the walk from the
  // cursor stops at the lap's end, and the NULL bucket and the wrap, which
  // an earlier walk of the lap visited, are not read again.
  const wrapped = input.wrapped === true;
  const withinLap = (alias: string) =>
    wrapped
      ? Prisma.sql` AND ${quoted(alias)}."tenant" <= ${lapEnd}`
      : Prisma.empty;
  const lapOpen = Prisma.raw(wrapped ? "false" : "true");

  // The NULL bucket's turn: after every company past the cursor.
  const nullTurn = Prisma.sql`${input.maxTenants + 1}::int`;

  /** One probe: the first company past `previous` with rows in the index. */
  const nextTenant = (previous: Prisma.Sql) => Prisma.sql`(
        SELECT ${tenant} FROM ${table}
        WHERE ${indexed} AND ${tenant} > ${previous}${floor}
        ORDER BY ${tenant} LIMIT 1
      )`;

  /**
   * One probe per class: the ids of up to rowsPerTenant due rows of the
   * company `which` selects, oldest first, the first class's before the
   * next's (see `classes`). Carried by the walk, so a company is read once.
   */
  const classes: ReadonlyArray<((alias: string | null) => Prisma.Sql) | null> =
    queue.classes && queue.classes.length > 0 ? queue.classes : [null];

  const thenBy =
    queue.thenBy && queue.thenBy.length > 0
      ? Prisma.sql`, ${Prisma.join(queue.thenBy.map(quoted), ", ")}`
      : Prisma.empty;

  const probe = (which: Prisma.Sql, index: number, share?: Prisma.Sql) => {
    const only = classes[index];
    const ofClass = only ? Prisma.sql` AND ${only(null)}` : Prisma.empty;

    // With a share, the rows the company may take, held as they are read
    // (see `share`); a share of 0 or less reads nothing.
    const rows = share
      ? Prisma.sql`GREATEST(0, LEAST(${perTenant}, ${share}))`
      : perTenant;
    const lock = share ? Prisma.sql` FOR UPDATE SKIP LOCKED` : Prisma.empty;

    return Prisma.sql`ARRAY(
        SELECT "id" FROM ${table}
        WHERE ${indexed}
          AND ${which}${ofClass}
          AND ${due}${floor}
        ORDER BY ${tenant}, ${dueAt}${thenBy}
        LIMIT ${rows}${lock}
      )`;
  };

  // A class after the first is read only while the ones before it came
  // back short, and what they found keeps its place at the front.
  const dueIdsWhere = (which: Prisma.Sql, share?: Prisma.Sql): Prisma.Sql =>
    classes.slice(1).reduce(
      (before, _, offset) => Prisma.sql`(
        SELECT CASE
          WHEN cardinality("p"."ids") >= ${perTenant} THEN "p"."ids"
          ELSE ("p"."ids" || ${probe(which, offset + 1, share)})[1:${perTenant}]
        END
        FROM (SELECT ${before} AS "ids" OFFSET 0) AS "p"
      )`,
      probe(which, 0, share),
    );

  // The company as a range of one value, ordered by (company, due time), on
  // purpose: with `= company` the planner drops the company from the order
  // and may read the queue's due-time index instead, filtering by company.
  // It does so when the statistics see few companies (a young table, one
  // carrier alone) — and then a small company behind a flood is found
  // after the whole flood. Only the fair index gives this order.
  const dueIdsOf = (company: Prisma.Sql) =>
    dueIdsWhere(
      Prisma.sql`${tenant} >= ${company} AND ${tenant} <= ${company}`,
      queue.share?.(company),
    );

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

  const prelude = queue.with ? Prisma.sql`${queue.with},` : Prisma.empty;

  // The group cap's cut (see `groupCap`): the candidates ranked within
  // their company's group, kept while within the group's room.
  const admitted = queue.groupCap
    ? Prisma.sql`
    "admitted" ("id", "pass", "turn", "ord", "tenant") AS (
      SELECT "id", "pass", "turn", "ord", "tenant" FROM (
        SELECT "c"."id", "c"."pass", "c"."turn", "c"."ord", "c"."tenant",
               "g"."group",
               row_number() OVER (
                 PARTITION BY "g"."group"
                 ORDER BY "c"."pass", "c"."turn", "c"."ord", "c"."id"
               ) AS "rank"
        FROM "candidates" AS "c"
        CROSS JOIN LATERAL (
          SELECT ${queue.groupCap.of(Prisma.raw(`"c"."tenant"`))} AS "group"
        ) AS "g"
      ) AS "ranked"
      WHERE "ranked"."group" IS NULL
         OR "ranked"."rank" <= ${queue.groupCap.room(Prisma.raw(`"ranked"."group"`))}
    ),`
    : Prisma.empty;
  const pool = Prisma.raw(queue.groupCap ? `"admitted"` : `"candidates"`);

  // Without the fill, no row outside the walk: the shares are the claim.
  const oldest =
    queue.fill === false
      ? Prisma.sql`SELECT NULL::text, NULL::bigint WHERE false`
      : Prisma.sql`SELECT "id", row_number() OVER (ORDER BY ${dueAt}) FROM (
        SELECT "id", ${dueAt} FROM ${table}
        WHERE ${indexed} AND ${due}${floor}
        ORDER BY ${dueAt}
        LIMIT ${limit}
      ) AS "head"`;

  const walk = Prisma.sql`
    WITH RECURSIVE
    ${prelude}
    "after" ("n", "tenant", "found", "ids") AS (
      SELECT 1, "first"."tenant", cardinality("first"."ids"), "first"."ids"
      FROM ${step(cursor)} AS "first"
      WHERE "first"."tenant" IS NOT NULL${withinLap("first")}
      UNION ALL
      SELECT "after"."n" + 1, "next"."tenant",
             "after"."found" + cardinality("next"."ids"), "next"."ids"
      FROM "after"
      CROSS JOIN LATERAL ${step(Prisma.raw(`"after"."tenant"`))} AS "next"
      WHERE "next"."tenant" IS NOT NULL${withinLap("next")}
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
          AND ${lapOpen}
        THEN ${dueIdsWhere(Prisma.sql`${tenant} IS NULL`)}
        ELSE ARRAY[]::text[]
      END
      FROM "after_end"
    ),
    -- The wrap: from the first company up to the lap's end (the cursor,
    -- unless the lap started before it), only when what came before it is
    -- still short of the limit.
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
          AND ${lapEnd} <> ''
          AND ${lapOpen}
      ) AS "first"
      WHERE "first"."tenant" IS NOT NULL
        AND "first"."tenant" <= ${lapEnd}
      UNION ALL
      SELECT "before"."n" + 1, "next"."tenant",
             "before"."found" + cardinality("next"."ids"), "next"."ids"
      FROM "before"
      CROSS JOIN LATERAL ${step(Prisma.raw(`"before"."tenant"`))} AS "next"
      WHERE "next"."tenant" IS NOT NULL
        AND "next"."tenant" <= ${lapEnd}
        AND "before"."n" < ${maxTenants}
        AND "before"."found" < ${limit}
    ),
    "fair" ("id", "turn", "ord", "tenant") AS (
      SELECT "row"."id", "visits"."turn", "row"."ord", "visits"."tenant"
      FROM (
        SELECT "n" AS "turn", "ids", "tenant" FROM "after"
        UNION ALL
        SELECT ${nullTurn}, "ids", NULL::text FROM "nulls"
        UNION ALL
        SELECT ${nullTurn} + "n", "ids", "tenant" FROM "before"
      ) AS "visits"
      CROSS JOIN LATERAL unnest("visits"."ids") WITH ORDINALITY AS "row" ("id", "ord")
    ),
    "oldest" ("id", "ord") AS (
      ${oldest}
    ),
    "candidates" ("id", "pass", "turn", "ord", "tenant") AS (
      SELECT DISTINCT ON ("id") "id", "pass", "turn", "ord", "tenant" FROM (
        SELECT "id", 0 AS "pass", "turn", "ord", "tenant" FROM "fair"
        UNION ALL
        SELECT "id", 1, 0, "ord", NULL::text FROM "oldest"
      ) AS "both"
      ORDER BY "id", "pass"
    ),${admitted}
    -- Where the walk ended; whether a visit bound stopped it (the walk
    -- from the cursor at maxTenants skips the NULL bucket and the wrap,
    -- the wrap at maxTenants stops short of the lap's end); and whether it
    -- ended in the wrap, past the last company.
    "walk_end" ("tenant", "cut", "wrapped") AS (
      SELECT coalesce(
        (SELECT "tenant" FROM "before" ORDER BY "n" DESC LIMIT 1),
        (SELECT "tenant" FROM "after" ORDER BY "n" DESC LIMIT 1),
        ''
      ),
      (SELECT "n" FROM "after_end") >= ${maxTenants}
        OR coalesce((SELECT max("n") FROM "before"), 0) >= ${maxTenants},
      EXISTS (SELECT 1 FROM "before")
    )`;

  const update = Prisma.sql`
    UPDATE ${table} SET ${queue.set}
    WHERE "id" IN (
      SELECT "row"."id" FROM ${table} AS "row"
      JOIN ${pool} AS "candidates" ON "candidates"."id" = "row"."id"
      -- Checked again under the lock: another process may have taken it.
      WHERE ${queue.indexed("row")} AND ${queue.due("row")}${input.rowFloor}
      ORDER BY "candidates"."pass", "candidates"."turn",
               "candidates"."ord", "row"."id"
      LIMIT ${limit}
      FOR UPDATE OF "row" SKIP LOCKED
    )${floor}`;

  // The walk's row joined to what was claimed: never no row, so the walk
  // comes back with an empty claim too (see `reportsWalk`).
  if (queue.reportsWalk) {
    return Prisma.sql`${walk},
    "claimed" AS (${update}
      RETURNING ${Prisma.raw(queue.returning)}
    )
    SELECT "claimed".*,
           "walk_end"."tenant" AS "fairCursor",
           "walk_end"."cut" AS "fairCut",
           "walk_end"."wrapped" AS "fairWrapped"
    FROM "walk_end" LEFT JOIN "claimed" ON true
  `;
  }

  return Prisma.sql`${walk}${update}
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

/** A claim of a queue that `reportsWalk`, as fairWalkOf reads it. */
interface FairWalk<T> {
  /** The rows claimed. */
  rows: T[];

  /** The walk's end: where the next walk starts. */
  cursor: string;

  /** A visit bound stopped the walk before the lap's end. */
  cut: boolean;

  /** The walk ended in the wrap, past the last company. */
  wrapped: boolean;
}

/** The walk's columns on every row of a `reportsWalk` statement. */
interface FairWalkColumns {
  fairCursor?: string | null;
  fairCut?: boolean | null;
  fairWrapped?: boolean | null;
}

/**
 * A `reportsWalk` statement's result as the claimed rows, without the
 * walk's columns, and the walk itself: every row carries it, and the one
 * row of an empty claim has a null id.
 */
function fairWalkOf<T extends { id: unknown }>(
  result: ReadonlyArray<T & FairWalkColumns>,
): FairWalk<T> {
  const walk = result[0];
  const rows: T[] = [];

  for (const row of result) {
    if (row.id === null || row.id === undefined) continue;

    const claimed: Partial<T & FairWalkColumns> = { ...row };

    delete claimed.fairCursor;
    delete claimed.fairCut;
    delete claimed.fairWrapped;

    rows.push(claimed as T);
  }

  return {
    rows,
    cursor: walk?.fairCursor ?? "",
    cut: walk?.fairCut === true,
    wrapped: walk?.fairWrapped === true,
  };
}

/**
 * Walks a queue that `reportsWalk` from `cursor` until something is
 * claimed or the lap closes: a walk its visit bound cut short with nothing
 * claimed goes on from where it stopped, and the lap ends at the cursor
 * the first walk started from (each later walk gets it as lapEnd, and,
 * once one ended past the last company, `wrapped`). At most `maxWalks`
 * walks, each a statement of its own: what is left of the lap is the next
 * claim's, from the cursor this one reached.
 *
 * `onCursor` hears each walk's end as it comes, so a walk that fails
 * after others keeps the ground they covered.
 */
async function walkFairLap<T>(options: {
  cursor: string;
  maxWalks: number;
  walk: (at: {
    cursor: string;
    lapEnd: string;
    wrapped: boolean;
  }) => Promise<FairWalk<T>>;
  onCursor?: (cursor: string) => void;
}): Promise<{ rows: T[]; cursor: string; walks: number }> {
  const lapEnd = options.cursor;

  let cursor = options.cursor;
  let wrapped = false;
  let walks = 0;

  while (walks < options.maxWalks) {
    const walk = await options.walk({ cursor, lapEnd, wrapped });

    walks += 1;
    cursor = walk.cursor;
    options.onCursor?.(cursor);

    // Something claimed, the lap closed on its own, or the bound stopped
    // the walk right at the lap's end.
    if (walk.rows.length > 0 || !walk.cut || cursor === lapEnd) {
      return { rows: walk.rows, cursor, walks };
    }

    wrapped ||= walk.wrapped;
  }

  return { rows: [], cursor, walks };
}

export { columnOf, fairClaimSql, fairWalkOf, nextFairCursor, walkFairLap };
export type { FairClaimInput, FairQueue, FairWalk };
