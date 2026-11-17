import { Prisma } from "@prisma/client";

import {
  isDriverAdapterError,
  sqlStateOf,
} from "@/shared/errors/prisma-error-meta";

/**
 * Postgres refusals that mean "busy right now", not "broken" (plano-escala
 * U-13).
 *
 * The runtime URL carries `lock_timeout=5000` and `statement_timeout=30000`
 * in its `options` (docs/deploy.md, section 7.7), and the database roles of
 * the cut carry the same ceilings (infra/sql/20-runtime-roles.sql). A lock
 * wait that runs out — a row another transaction holds, or one of the
 * `pg_advisory_xact_lock` keys that serialize a company's codes, quotas and
 * boards (delivery, route, kanban, API key and webhook repositories) —
 * fails with 55P03; a statement cancelled by its ceiling, with 57014. Both
 * used to leave as "Internal server error": a 500 a generic client does
 * not retry, logged among the bugs.
 *
 * Neither is about the request: the same call works once the other
 * transaction is done. So the handler answers 503 SERVICE_BUSY with a short
 * Retry-After, and the clients already treat a 503 as temporary (the app
 * honours Retry-After; the web shows the message). Nothing is retried here:
 * Postgres rolled the transaction back, and repeating a write is the
 * caller's call, with its Idempotency-Key where the route asks for one.
 *
 * One map for every such refusal, so the PgBouncer refusals of the wave 17
 * (F4-32) land next to these instead of in another branch of the handler.
 *
 * Only typed errors are trusted, as in database-unavailable.ts: Prisma's
 * own class (a model query's P2039, a raw query's P2010, with the SQLSTATE
 * in the adapter's cause) and the adapter's bare error a failed COMMIT
 * throws. A plain Error that merely carries a `code` proves nothing.
 */

const SERVICE_BUSY_CODE = "SERVICE_BUSY";

const SERVICE_BUSY_MESSAGE =
  "O sistema está ocupado; tente de novo em instantes.";

/**
 * Shorter than the outage's 5 s (DATABASE_RETRY_AFTER_SECONDS): the server
 * is up, and the transaction in the way usually ends in well under that.
 */
const SERVICE_BUSY_RETRY_AFTER_SECONDS = 2;

/** SQLSTATE → which ceiling ran out, for the log line. */
const BUSY_SQLSTATES: ReadonlyMap<string, DatabaseBusyReason> = new Map([
  // lock_not_available: lock_timeout, also on pg_advisory_xact_lock.
  ["55P03", "lock_timeout"],
  // query_canceled: statement_timeout (or a cancel by hand).
  ["57014", "statement_timeout"],
]);

type DatabaseBusyReason = "lock_timeout" | "statement_timeout";

interface DatabaseBusyAnswer {
  statusCode: 503;
  code: typeof SERVICE_BUSY_CODE;
  message: string;
  retryAfterSeconds: number;
  /** For the log only: which ceiling ran out, and its SQLSTATE. */
  reason: DatabaseBusyReason;
  sqlState: string;
}

/** Whether the error is one of the classes this map trusts. */
function isTypedDatabaseError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) return true;

  return error instanceof Error && isDriverAdapterError(error);
}

/**
 * The answer for a database refusal that means "busy", or null for
 * anything else (a 500 stays a 500, an outage stays SERVICE_UNAVAILABLE).
 */
function databaseBusyAnswer(error: unknown): DatabaseBusyAnswer | null {
  if (!isTypedDatabaseError(error)) return null;

  const sqlState = sqlStateOf(error);
  const reason = sqlState ? BUSY_SQLSTATES.get(sqlState) : undefined;

  if (!sqlState || !reason) return null;

  return {
    statusCode: 503,
    code: SERVICE_BUSY_CODE,
    message: SERVICE_BUSY_MESSAGE,
    retryAfterSeconds: SERVICE_BUSY_RETRY_AFTER_SECONDS,
    reason,
    sqlState,
  };
}

export {
  SERVICE_BUSY_CODE,
  SERVICE_BUSY_MESSAGE,
  SERVICE_BUSY_RETRY_AFTER_SECONDS,
  databaseBusyAnswer,
};
export type { DatabaseBusyAnswer, DatabaseBusyReason };
