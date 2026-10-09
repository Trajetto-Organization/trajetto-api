import { Prisma } from "@prisma/client";

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
 * - P2024: no connection free in the pool within pool_timeout — the database
 *   may be up, but this replica cannot use it now.
 * - P2037: Postgres refused a new connection (max_connections reached).
 *
 * Constraint and not-found codes (P2002, P2025, ...) are deliberately absent:
 * those are answers about the data, and a retry would get the same answer.
 */
const UNAVAILABLE_CODES = new Set(["P1001", "P1002", "P1008", "P1017", "P2024", "P2037"]);

/**
 * P2028 covers every interactive-transaction failure; only the variant where
 * the transaction could not even START is about capacity (it waited for a
 * connection). "Transaction already closed" means our own code outlived its
 * timeout, which is a bug to see, not an outage to retry.
 */
const TRANSACTION_START_TIMEOUT = /unable to start a transaction/i;

/**
 * P2010 is every failed `$queryRaw`/`$executeRaw`. Postgres' own refusals
 * carry their SQLSTATE in `meta.code` (42P01, 22003, 57014 for the
 * statement_timeout...) — answers about the SQL, a 500. What never reached
 * an answer carries none: past socket_timeout on a dead peer the engine
 * reports `N/A` as the code AND the message (measured on Prisma 6.1, GAP6-4;
 * tests/E2E/runtime-database-dead-peer.test.ts). A column the engine cannot
 * decode is `N/A` too, but WITH a message of its own — our query's fault,
 * so it stays out. Only the empty pair is the outage.
 */
function isRawQueryWithoutAnswer(error: Prisma.PrismaClientKnownRequestError): boolean {
  if (error.code !== "P2010") return false;

  const meta = error.meta as { code?: unknown; message?: unknown } | undefined;

  return meta?.code === "N/A" && meta?.message === "N/A";
}

/**
 * Whether an error means the database is unavailable to this replica.
 *
 * Used to answer 503 + Retry-After instead of a 500 that a generic client
 * will not retry, and to keep "the database is down" apart from "the code is
 * broken" in logs and alerts. Only Prisma's own error classes are trusted: a
 * plain Error whose message merely mentions a database proves nothing.
 *
 * A 503 from this classifier does NOT mean "not executed". P1017 was observed
 * AFTER a COMMIT had reached Postgres — the connection died on the way back —
 * so a write may have landed. Repeating a non-idempotent request is only safe
 * with an Idempotency-Key; the app's outbox sends one.
 */
function isDatabaseUnavailable(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientInitializationError) return true;

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (UNAVAILABLE_CODES.has(error.code)) return true;

    if (isRawQueryWithoutAnswer(error)) return true;

    return error.code === "P2028" && TRANSACTION_START_TIMEOUT.test(error.message);
  }

  return false;
}

export { DATABASE_RETRY_AFTER_SECONDS, isDatabaseUnavailable };
