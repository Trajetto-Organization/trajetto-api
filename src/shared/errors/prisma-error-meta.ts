/**
 * What a Prisma error says about the database's own answer, under Prisma 7.
 *
 * Prisma 6's Rust engine put the details in `meta`: the columns or index of a
 * unique violation in `meta.target`, a raw query's SQLSTATE in `meta.code`.
 * Prisma 7 hands over the driver adapter's error instead, as
 * `meta.driverAdapterError.cause`: `{ kind, originalCode, constraint }`. A
 * unique violation names the INDEX there (`constraint.index`), or the columns
 * (`constraint.fields`) when Postgres gave no constraint name.
 *
 * Both spellings are read, so an error built by hand (the in-memory twins,
 * tests) and one from Postgres take the same path.
 *
 * One answer escapes Prisma's classes altogether: what Postgres refuses at
 * the COMMIT of an interactive `$transaction`. Prisma 7 runs that COMMIT
 * outside the path that turns the adapter's errors into a
 * PrismaClientKnownRequestError (measured on 7.10.1 + adapter-pg), so the
 * caller gets the bare DriverAdapterError, with the same `{ kind,
 * originalCode }` as its own `cause`. That shape is read too: a conflict
 * there is isSerializationFailure's (below), the database going away there
 * is isDatabaseUnavailable's (database-unavailable.ts).
 */

import { Prisma } from "@prisma/client";

interface DriverAdapterCause {
  /** `UniqueConstraintViolation`, `DatabaseNotReachable`, `postgres`… */
  kind?: string;

  /** Postgres' SQLSTATE (`23505`, `57P01`…), when Postgres answered. */
  originalCode?: string;

  /** Same, for the generic `postgres` kind. */
  code?: string;

  constraint?: { fields?: unknown; index?: unknown };
}

function metaOf(error: unknown): Record<string, unknown> | undefined {
  if (typeof error !== "object" || error === null) return undefined;

  const meta = (error as { meta?: unknown }).meta;

  return typeof meta === "object" && meta !== null
    ? (meta as Record<string, unknown>)
    : undefined;
}

/**
 * A driver adapter's own error, recognised the way
 * `@prisma/driver-adapter-utils` does: named DriverAdapterError, with the
 * adapter's verdict as an object `cause`.
 */
function isDriverAdapterError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;

  const { name, cause } = error as { name?: unknown; cause?: unknown };

  return (
    name === "DriverAdapterError" && typeof cause === "object" && cause !== null
  );
}

/**
 * The adapter's verdict behind an error: `meta.driverAdapterError.cause` of a
 * Prisma 7 error, or the `cause` of a bare DriverAdapterError (a refused
 * COMMIT). Undefined for anything else.
 */
function driverAdapterCauseOf(error: unknown): DriverAdapterCause | undefined {
  const adapterError = isDriverAdapterError(error)
    ? error
    : metaOf(error)?.driverAdapterError;

  if (typeof adapterError !== "object" || adapterError === null) {
    return undefined;
  }

  const cause = (adapterError as { cause?: unknown }).cause;

  return typeof cause === "object" && cause !== null
    ? (cause as DriverAdapterCause)
    : undefined;
}

/**
 * The unique key a P2002 names: the columns (an array) or the index name (a
 * string), as `meta.target` used to be. Undefined when the error names none.
 *
 * Under Prisma 7 it is usually the index name — `driver_businessId_cpf_key`
 * for an `@@unique`, the raw name for an index created in SQL — so callers
 * match on a fragment of it (the column), never on the whole value.
 */
function uniqueTargetOf(error: unknown): string[] | string | undefined {
  const target = metaOf(error)?.target;

  if (Array.isArray(target)) return target.map(String);
  if (typeof target === "string") return target;

  const constraint = driverAdapterCauseOf(error)?.constraint;

  if (Array.isArray(constraint?.fields)) return constraint.fields.map(String);
  if (typeof constraint?.index === "string") return constraint.index;

  return undefined;
}

/** Postgres' SQLSTATE behind a failed query, under either Prisma version. */
function sqlStateOf(error: unknown): string | undefined {
  const cause = driverAdapterCauseOf(error);
  const code = cause?.originalCode ?? cause?.code ?? metaOf(error)?.code;

  return typeof code === "string" && code !== "N/A" ? code : undefined;
}

/**
 * The SQLSTATEs that mean "run the whole transaction again": a serialization
 * failure (40001) and a deadlock (40P01; isSerializationFailure says why).
 */
const SERIALIZATION_SQLSTATES = new Set(["40001", "40P01"]);

/**
 * Whether Postgres aborted a transaction only because a concurrent one got
 * there first, so the same transaction run again from the top may succeed.
 * The serializable retry loops (fuel and checklist repositories) ask this.
 *
 * Under Prisma 7 the refusal has three shapes, and checking for P2034 alone
 * caught one of them:
 *
 * - P2034, when a model query inside the transaction is refused (Prisma 6
 *   used this code for every case);
 * - P2010, when the refused statement is a `$queryRaw`/`$executeRaw`, the
 *   SQLSTATE in the adapter's cause (Prisma 7) or in `meta.code` (Prisma 6);
 * - a bare DriverAdapterError of kind `TransactionWriteConflict`, when the
 *   refusal comes at COMMIT, which is where Postgres' serializable checking
 *   usually catches two transactions that only read and insert. Prisma 6
 *   reported it as P2034; Prisma 7.10.1 lets the adapter's error through,
 *   and the loops gave up after one attempt with a 500
 *   (tests/E2E/serializable-commit-retry.test.ts).
 *
 * A deadlock (40P01) counts too, on purpose. adapter-pg maps 40P01 to the
 * same `TransactionWriteConflict` kind as 40001, and Prisma reports both as
 * P2034 ("a write conflict or a deadlock"), so the loops have retried
 * deadlocks since they were written; leaving 40P01 out here would only
 * change the answer for the shapes that carry the SQLSTATE. Postgres rolls
 * back the deadlock victim's whole transaction, so running it again from the
 * top is safe, and the Postgres manual advises retrying 40P01 along with
 * 40001. The retry is a safety net, not the fix: a deadlock that keeps
 * coming back is a lock-order bug to fix where the locks are taken
 * (tests/E2E/route-cancel-lock-order.test.ts), and every caller's attempt
 * budget stops it from looping.
 */
function isSerializationFailure(error: unknown): boolean {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2034"
  ) {
    return true;
  }

  if (driverAdapterCauseOf(error)?.kind === "TransactionWriteConflict") {
    return true;
  }

  const state = sqlStateOf(error);

  return state !== undefined && SERIALIZATION_SQLSTATES.has(state);
}

export {
  driverAdapterCauseOf,
  isDriverAdapterError,
  isSerializationFailure,
  sqlStateOf,
  uniqueTargetOf,
};
export type { DriverAdapterCause };
