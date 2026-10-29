import { Prisma } from "@prisma/client";

import {
  DatabaseUnavailableError,
  UNMAPPED_SOCKET_ERRNOS,
} from "@/shared/database/pg-driver";
import {
  driverAdapterCauseOf,
  isDriverAdapterError,
  sqlStateOf,
} from "@/shared/errors/prisma-error-meta";

/**
 * How long a caller is told to wait when the database is unavailable.
 *
 * Short on purpose: a Postgres restart or a failover is back in seconds, and
 * the readiness probe takes a replica out of the balancer in about ten. The
 * app honours it as a floor on its own backoff, never as a fixed delay.
 */
const DATABASE_RETRY_AFTER_SECONDS = 5;

/**
 * Prisma codes that mean "no database right now", not "this request is wrong".
 *
 * - P1001: the server cannot be reached (refused, DNS, network).
 * - P1002: reached, but it timed out.
 * - P1008: the operation timed out.
 * - P1017: the server closed the connection (restart, failover, a terminated
 *   backend, a proxy recycling its upstream).
 * - P2024: no connection free in the pool within pool_timeout (Prisma 6; under
 *   Prisma 7 the pool is pg's, and its timeout is a DatabaseUnavailableError).
 * - P2037: Postgres refused a new connection (max_connections reached).
 *
 * Constraint and not-found codes (P2002, P2025, ...) are deliberately absent:
 * those are answers about the data, and a retry would get the same answer.
 */
const UNAVAILABLE_CODES = new Set([
  "P1001",
  "P1002",
  "P1008",
  "P1017",
  "P2024",
  "P2037",
]);

/**
 * P2028 covers every interactive-transaction failure; only the variant where
 * the transaction could not even START is about capacity (it waited for a
 * connection). "Transaction already closed" means our own code outlived its
 * timeout, which is a bug to see, not an outage to retry.
 */
const TRANSACTION_START_TIMEOUT = /unable to start a transaction/i;

/**
 * The driver adapter's kinds for "no answer from the database". A model query
 * gets them as P1001/P1017/P1008/P2037 (above); a raw query gets every
 * adapter error as P2010, and a failed COMMIT the adapter's error bare, so
 * the kind is read from the cause.
 */
const UNAVAILABLE_KINDS = new Set([
  "DatabaseNotReachable",
  "ConnectionClosed",
  "SocketTimeout",
  "TooManyConnections",
]);

/**
 * SQLSTATEs Postgres sends when it is the one going away: the server shutting
 * down or recovering (57P01-57P03), the connection itself failing (class 08),
 * no connection slot left (53300). Under Prisma 7 a model query gets them as
 * P2039 "Database error", a raw one as P2010 and a COMMIT as the bare
 * adapter error (kind `postgres`). Everything else Postgres refuses (42P01,
 * 22003, 57014 for the statement_timeout...) is an answer about the SQL: a
 * 500.
 */
const UNAVAILABLE_SQLSTATES = new Set([
  "57P01",
  "57P02",
  "57P03",
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "53300",
]);

/**
 * P2010 is every failed `$queryRaw`/`$executeRaw`. Under Prisma 6, what never
 * reached an answer carried `N/A` as the code AND the message (measured on
 * Prisma 6.1, GAP6-4; tests/E2E/runtime-database-dead-peer.test.ts). Kept for
 * an error built that way; Prisma 7 sends the adapter's cause instead.
 */
function isRawQueryWithoutAnswer(
  error: Prisma.PrismaClientKnownRequestError,
): boolean {
  if (error.code !== "P2010") return false;

  const meta = error.meta as { code?: unknown; message?: unknown } | undefined;

  return meta?.code === "N/A" && meta?.message === "N/A";
}

/**
 * Whether the driver adapter's verdict behind an error, wherever it rides,
 * is the database going away: one of the kinds above, or a SQLSTATE Postgres
 * sends when it is the one leaving.
 */
function isAdapterVerdictWithoutAnswer(error: unknown): boolean {
  const kind = driverAdapterCauseOf(error)?.kind;

  if (kind && UNAVAILABLE_KINDS.has(kind)) return true;

  const state = sqlStateOf(error);

  return state !== undefined && UNAVAILABLE_SQLSTATES.has(state);
}

/** P2010/P2039 whose driver-adapter cause is the database going away. */
function isDriverErrorWithoutAnswer(
  error: Prisma.PrismaClientKnownRequestError,
): boolean {
  if (error.code !== "P2010" && error.code !== "P2039") return false;

  return isAdapterVerdictWithoutAnswer(error);
}

/**
 * The bare DriverAdapterError a failed COMMIT throws, when what failed is the
 * database going away.
 *
 * Prisma 7 runs the COMMIT of an interactive `$transaction` outside the path
 * that wraps the adapter's errors in its classes (prisma-error-meta.ts), so
 * the caller gets the adapter's own error. Measured on 7.10.1 + adapter-pg:
 * a backend terminated during the COMMIT (a restart, a failover) arrives as
 * kind `postgres` with 57P01; a connection reset after the COMMIT ran, as
 * `ConnectionClosed`. Prisma 6 reported both as P1017, a 503; untyped, they
 * answered 500 with no Retry-After
 * (tests/E2E/commit-database-unavailable-http.test.ts).
 *
 * Only an Error under the adapter's own name counts, as everywhere else in
 * this file a class is what is trusted. A conflict or a constraint refused at
 * COMMIT is an answer about the data, and stays out. The serializable retry
 * loops do not run these again (isSerializationFailure is false for them):
 * the reset one had committed, and a second run would write it twice.
 */
function isBareAdapterErrorWithoutAnswer(error: unknown): boolean {
  return (
    error instanceof Error &&
    isDriverAdapterError(error) &&
    isAdapterVerdictWithoutAnswer(error)
  );
}

/**
 * Whether an error means the database is unavailable to this replica.
 *
 * Used to answer 503 + Retry-After instead of a 500 that a generic client
 * will not retry, and to keep "the database is down" apart from "the code is
 * broken" in logs and alerts. Only typed errors are trusted — Prisma's own
 * classes, the adapter's own error that a failed COMMIT throws, and the
 * pool's DatabaseUnavailableError (src/shared/database/pg-driver.ts, which
 * types pg's full-pool, connect, dead-connection and read-timeout errors, and
 * the socket errnos the adapter does not map, at the source): a plain Error
 * whose message merely mentions a database proves nothing.
 *
 * A 503 from this classifier does NOT mean "not executed". P1017 was observed
 * AFTER a COMMIT had reached Postgres — the connection died on the way back —
 * so a write may have landed; under Prisma 7 the same case is the bare
 * `ConnectionClosed`. Repeating a non-idempotent request is only safe with an
 * Idempotency-Key; the app's outbox sends one. (The pool's error says which
 * case it is in `reason`; the audit trail's retry reads it.)
 */
function isDatabaseUnavailable(error: unknown): boolean {
  if (error instanceof DatabaseUnavailableError) return true;

  if (error instanceof Prisma.PrismaClientInitializationError) return true;

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (UNAVAILABLE_CODES.has(error.code)) return true;

    // A socket errno the adapter does not map, as Prisma raises one that
    // reaches it untyped: the errno becomes the code. The API's pool types
    // them first (pg-driver.ts); this keeps the 503 for one it did not see.
    if (UNMAPPED_SOCKET_ERRNOS.has(error.code)) return true;

    if (isDriverErrorWithoutAnswer(error)) return true;

    if (isRawQueryWithoutAnswer(error)) return true;

    return (
      error.code === "P2028" && TRANSACTION_START_TIMEOUT.test(error.message)
    );
  }

  return isBareAdapterErrorWithoutAnswer(error);
}

export { DATABASE_RETRY_AFTER_SECONDS, isDatabaseUnavailable };
