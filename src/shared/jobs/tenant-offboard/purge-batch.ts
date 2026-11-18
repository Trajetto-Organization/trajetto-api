import { Prisma } from "@prisma/client";

import { sqlStateOf } from "@/shared/errors/prisma-error-meta";

import type {
  ChildrenStep,
  DeletingStep,
  DirectStep,
  PurgeDependent,
  ScanStep,
} from "./purge-plan";

/**
 * One batch of a purge step as SQL (plano-escala F3-26a), and the rules
 * that keep every batch a short transaction.
 *
 * A batch is one DELETE of at most `limit` rows picked by the table's key
 * (`DELETE … WHERE key IN (SELECT key … LIMIT n)`), with the rows of its
 * dependents in the same statement (data-modifying CTEs). The job runs
 * each batch in its own transaction with its cursor (the fenced
 * checkpoint), under SET LOCAL statement_timeout and lock_timeout and
 * Prisma's own transaction timeout: no transaction of the purge may pass
 * TENANT_PURGE_TRANSACTION_MS, and a row another transaction holds is
 * waited for a little, never for long. A batch that ran out of time is
 * rolled back whole and tried again with half the rows; one that took long
 * halves the next, one that was quick doubles it, between 1 and
 * PURGE_BATCH_MAX rows.
 *
 * Identifiers come from the plan (purge-plan.ts), constants of the code,
 * checked against IDENTIFIER before they reach the SQL; the company and
 * the cursors are bound parameters.
 */

/** The purge's ceiling for one transaction, its commit included. */
const TENANT_PURGE_TRANSACTION_MS = 5_000;

/** Each statement's ceiling: room for the cursor and the commit after. */
const PURGE_STATEMENT_TIMEOUT_MS = 3_000;

/** How long a batch waits for a row another transaction holds. */
const PURGE_LOCK_TIMEOUT_MS = 2_000;

const PURGE_BATCH_START = 500;
const PURGE_BATCH_MAX = 5_000;

/** Parents a `children` batch looks under. */
const PURGE_PARENTS_PER_BATCH = 100;

/** Keys a `scan` batch walks: its rows are read, not all deleted. */
const PURGE_SCAN_CHUNK = 5_000;

/** A batch slower than this halves the next; faster than the low, doubles. */
const PURGE_BATCH_SLOW_MS = 1_000;
const PURGE_BATCH_FAST_MS = 200;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A quoted identifier of the plan; anything else is refused. */
function ident(name: string): Prisma.Sql {
  if (!IDENTIFIER.test(name)) {
    throw new Error(`expurgo: identificador inválido "${name}"`);
  }

  return Prisma.raw(`"${name}"`);
}

function keyOf(step: DeletingStep): readonly string[] {
  return step.key ?? ["id"];
}

/** `"a"` or `("a", "b")`: the key as a comparable tuple. */
function keyTuple(columns: readonly string[]): Prisma.Sql {
  const joined = Prisma.join(columns.map(ident), ", ");

  return columns.length === 1 ? joined : Prisma.sql`(${joined})`;
}

/** The step's own condition, a constant of the plan. */
function extraWhere(step: DirectStep): Prisma.Sql {
  if (!step.where) return Prisma.empty;

  // The plan's conditions are column comparisons with literals: no
  // statement separators, comments or parameters ever belong in one.
  if (/;|--|\/\*|\$/.test(step.where)) {
    throw new Error(`expurgo: condição inválida em ${step.table}`);
  }

  return Prisma.sql` AND ${Prisma.raw(step.where)}`;
}

/** The deleted rows' columns the dependents read, besides the key. */
function returning(step: DeletingStep): Prisma.Sql {
  const columns = new Set(keyOf(step));

  for (const dependent of step.dependents ?? []) {
    columns.add(dependent.from ?? keyOf(step)[0]);
  }

  return Prisma.join([...columns].map(ident), ", ");
}

function dependentSql(
  dependent: PurgeDependent,
  index: number,
  step: DeletingStep,
): Prisma.Sql {
  const from = dependent.from ?? keyOf(step)[0];

  return Prisma.sql`,
    ${Prisma.raw(`dependent_${index}`)} AS (
      DELETE FROM ${ident(dependent.table)}
      WHERE ${ident(dependent.column)} = ANY (ARRAY(SELECT ${ident(from)} FROM gone))
    )`;
}

/**
 * The DELETE of the rows `pick` selects (at most `limit`, by the key),
 * with its dependents; answers `deleted`.
 */
function deleteSql(
  step: DeletingStep,
  pick: Prisma.Sql,
  limit: number,
): Prisma.Sql {
  const table = ident(step.table);
  const key = keyTuple(keyOf(step));
  const columns = Prisma.join(keyOf(step).map(ident), ", ");
  const dependents = (step.dependents ?? []).map((dependent, index) =>
    dependentSql(dependent, index, step),
  );

  return Prisma.sql`
    WITH gone AS (
      DELETE FROM ${table}
      WHERE ${key} IN (
        SELECT ${columns} FROM ${table} WHERE ${pick} LIMIT ${limit}
      )
      RETURNING ${returning(step)}
    )${dependents.length > 0 ? Prisma.join(dependents, "") : Prisma.empty}
    SELECT count(*)::int AS "deleted" FROM gone
  `;
}

/** A `direct` batch: the company's rows through the column's index. */
function directBatchSql(
  step: DirectStep,
  businessId: string,
  limit: number,
): Prisma.Sql {
  return deleteSql(
    step,
    Prisma.sql`${ident(step.column)} = ${businessId}${extraWhere(step)}`,
    limit,
  );
}

/**
 * The next page of a `children` step's parents: their ids (the cursor)
 * and the values the children hold.
 */
function parentsPageSql(
  step: ChildrenStep,
  businessId: string,
  after: string,
  limit: number,
): Prisma.Sql {
  const parentKey = step.parentKey ?? "id";

  return Prisma.sql`
    SELECT "id"::text AS "id", ${ident(parentKey)}::text AS "value"
    FROM ${ident(step.parent)}
    WHERE ${ident(step.parentColumn ?? "businessId")} = ${businessId}
      AND "id" > ${after}
    ORDER BY "id"
    LIMIT ${limit}
  `;
}

/** A `children` batch: the rows under the given parents' values. */
function childrenBatchSql(
  step: ChildrenStep,
  values: readonly string[],
  limit: number,
): Prisma.Sql {
  const array =
    step.cast === "uuid"
      ? Prisma.sql`${values}::uuid[]`
      : Prisma.sql`${values}::text[]`;

  return deleteSql(
    step,
    Prisma.sql`${ident(step.column)} = ANY (${array})`,
    limit,
  );
}

/** The last key of the next chunk of a `scan` step, or null at the end. */
function scanChunkSql(
  step: ScanStep,
  after: string,
  chunk: number,
): Prisma.Sql {
  const [key] = keyOf(step);

  return Prisma.sql`
    SELECT max(${ident(key)})::text AS "upto" FROM (
      SELECT ${ident(key)} FROM ${ident(step.table)}
      WHERE ${ident(key)} > ${after}
      ORDER BY ${ident(key)}
      LIMIT ${chunk}
    ) AS chunk
  `;
}

/** A `scan` batch: the company's rows among the keys of one chunk. */
function scanBatchSql(
  step: ScanStep,
  businessId: string,
  after: string,
  upto: string,
): Prisma.Sql {
  const [key] = keyOf(step);

  return deleteSql(
    step,
    Prisma.sql`${ident(key)} > ${after} AND ${ident(key)} <= ${upto} AND ${ident(step.column)} = ${businessId}`,
    PURGE_SCAN_CHUNK,
  );
}

/** The SET LOCALs every purge transaction opens with. */
const PURGE_TRANSACTION_SETTINGS = [
  `SET LOCAL statement_timeout = '${PURGE_STATEMENT_TIMEOUT_MS}ms'`,
  `SET LOCAL lock_timeout = '${PURGE_LOCK_TIMEOUT_MS}ms'`,
] as const;

const QUERY_CANCELED = "57014";
const LOCK_NOT_AVAILABLE = "55P03";

/**
 * Whether a batch ran out of time (the statement's timeout, or Prisma's
 * of the whole transaction): tried again with fewer rows.
 */
function isOutOfTime(error: unknown): boolean {
  if (sqlStateOf(error) === QUERY_CANCELED) return true;

  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2028"
  );
}

/** Whether a batch waited too long for a row another transaction holds. */
function isLockBusy(error: unknown): boolean {
  return sqlStateOf(error) === LOCK_NOT_AVAILABLE;
}

/** The next batch's size, from how long this one took. */
function nextBatchSize(current: number, tookMs: number): number {
  if (tookMs > PURGE_BATCH_SLOW_MS) return Math.max(1, Math.floor(current / 2));

  if (tookMs < PURGE_BATCH_FAST_MS) {
    return Math.min(PURGE_BATCH_MAX, current * 2);
  }

  return current;
}

export {
  IDENTIFIER,
  PURGE_BATCH_MAX,
  PURGE_BATCH_START,
  PURGE_LOCK_TIMEOUT_MS,
  PURGE_PARENTS_PER_BATCH,
  PURGE_SCAN_CHUNK,
  PURGE_STATEMENT_TIMEOUT_MS,
  PURGE_TRANSACTION_SETTINGS,
  TENANT_PURGE_TRANSACTION_MS,
  childrenBatchSql,
  directBatchSql,
  ident,
  isLockBusy,
  isOutOfTime,
  keyOf,
  nextBatchSize,
  parentsPageSql,
  scanBatchSql,
  scanChunkSql,
};
