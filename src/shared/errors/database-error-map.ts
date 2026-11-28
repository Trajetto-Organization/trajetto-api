import { Prisma } from "@prisma/client";

import {
  driverAdapterCauseOf,
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
 * One map for every such refusal: PgBouncer's (plano-escala F4-32, from
 * wave 17 the runtime's URLs go through it) are here too, below.
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

type DatabaseBusyReason =
  "lock_timeout" | "statement_timeout" | PgBouncerBusyReason;

type PgBouncerBusyReason =
  "pgbouncer_query_wait_timeout" | "pgbouncer_max_client_conn";

type PgBouncerOutageReason =
  | "pgbouncer_server_login_retry"
  | "pgbouncer_server_conn_crashed"
  | "pgbouncer_shutting_down";

/**
 * PgBouncer's own refusals that mean "come back in a moment" (plano-escala
 * F4-32), a closed list.
 *
 * PgBouncer answers everything it says itself with SQLSTATE 08P01
 * (protocol_violation), at FATAL, and closes the client: a real protocol
 * violation, an option it does not track in a URL, a login it refuses —
 * bugs and misconfigurations that must stay a 500 — share the code with a
 * pool that is merely full. So the code alone proves nothing, and only
 * these exact words, as PgBouncer 1.26 writes them, are trusted (always on
 * a typed error, like the SQLSTATEs above). Two are load, SERVICE_BUSY
 * here; three are the database (or the pooler) going away, which
 * database-unavailable.ts answers as SERVICE_UNAVAILABLE, from this list:
 *
 *  - `query_wait_timeout`: every server connection of the pool stayed busy
 *    past query_wait_timeout (5 s in the image, infra/pgbouncer), and the
 *    statement never reached Postgres. A pool too small for the moment's
 *    load, or Postgres too slow: load, so `warn`, as a lock wait.
 *  - `no more connections allowed (max_client_conn)`: PgBouncer's ceiling
 *    of client connections, at the login. Thousands of clients is a leak or
 *    a budget gone wrong, worth a look: `error`.
 *  - `server login has been failing, …`: PgBouncer could not log in to
 *    Postgres (a restart, a failover, the database refusing), and turns new
 *    clients away until server_login_retry; temporary by design.
 *  - `server conn crashed?`: the server connection under the statement died
 *    (Postgres went away mid-statement), what a direct connection reports
 *    as 57P01 or a lost connection. It may have run, like those.
 *  - `pooler is shutting down`: the old task of a rolling of PgBouncer,
 *    refusing a new login while its clients leave.
 *
 * Anything else PgBouncer says stays a 500, to be seen and fixed.
 */
const PGBOUNCER_REFUSALS: ReadonlyArray<{
  matches: (message: string) => boolean;
  reason: PgBouncerBusyReason | PgBouncerOutageReason;
  answer: "busy" | "outage";
}> = [
  {
    matches: (message) => message === "query_wait_timeout",
    reason: "pgbouncer_query_wait_timeout",
    answer: "busy",
  },
  {
    matches: (message) =>
      message === "no more connections allowed (max_client_conn)",
    reason: "pgbouncer_max_client_conn",
    answer: "busy",
  },
  {
    matches: (message) =>
      message.startsWith("server login has been failing") &&
      message.endsWith("(server_login_retry)"),
    reason: "pgbouncer_server_login_retry",
    answer: "outage",
  },
  {
    matches: (message) => message === "server conn crashed?",
    reason: "pgbouncer_server_conn_crashed",
    answer: "outage",
  },
  {
    matches: (message) => message === "pooler is shutting down",
    reason: "pgbouncer_shutting_down",
    answer: "outage",
  },
];

/** PgBouncer's SQLSTATE for all it says itself. */
const PGBOUNCER_SQLSTATE = "08P01";

/** The reasons that need a look, logged at error level; the rest warn. */
const LOGGED_AS_ERROR: ReadonlySet<DatabaseBusyReason> = new Set([
  "statement_timeout",
  "pgbouncer_max_client_conn",
]);

interface DatabaseBusyAnswer {
  statusCode: 503;
  code: typeof SERVICE_BUSY_CODE;
  message: string;
  retryAfterSeconds: number;
  /** For the log only: which ceiling ran out, and its SQLSTATE. */
  reason: DatabaseBusyReason;
  sqlState: string;
  /** For the log only: `error` for what needs a look, else `warn`. */
  logLevel: "warn" | "error";
}

interface PgBouncerRefusal {
  reason: PgBouncerBusyReason | PgBouncerOutageReason;
  answer: "busy" | "outage";
}

/** Whether the error is one of the classes this map trusts. */
function isTypedDatabaseError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) return true;

  return error instanceof Error && isDriverAdapterError(error);
}

/**
 * Which of PgBouncer's refusals the error is (PGBOUNCER_REFUSALS), or null:
 * a typed error, SQLSTATE 08P01 and the exact words. The words are read
 * from the adapter's cause (Prisma 7) or from `meta` (Prisma 6's shape).
 */
function pgBouncerRefusal(error: unknown): PgBouncerRefusal | null {
  if (!isTypedDatabaseError(error)) return null;
  if (sqlStateOf(error) !== PGBOUNCER_SQLSTATE) return null;

  const cause = driverAdapterCauseOf(error) as
    { originalMessage?: unknown; message?: unknown } | undefined;
  const meta = (error as { meta?: { message?: unknown } }).meta;
  const message = [cause?.originalMessage, cause?.message, meta?.message].find(
    (value): value is string => typeof value === "string",
  );

  if (!message) return null;

  const refusal = PGBOUNCER_REFUSALS.find((entry) => entry.matches(message));

  return refusal ? { reason: refusal.reason, answer: refusal.answer } : null;
}

/**
 * The answer for a database refusal that means "busy", or null for
 * anything else (a 500 stays a 500, an outage stays SERVICE_UNAVAILABLE).
 */
function databaseBusyAnswer(error: unknown): DatabaseBusyAnswer | null {
  if (!isTypedDatabaseError(error)) return null;

  const sqlState = sqlStateOf(error);
  const pgBouncer = pgBouncerRefusal(error);
  const reason =
    pgBouncer?.answer === "busy"
      ? (pgBouncer.reason as PgBouncerBusyReason)
      : sqlState
        ? BUSY_SQLSTATES.get(sqlState)
        : undefined;

  if (!sqlState || !reason) return null;

  return {
    statusCode: 503,
    code: SERVICE_BUSY_CODE,
    message: SERVICE_BUSY_MESSAGE,
    retryAfterSeconds: SERVICE_BUSY_RETRY_AFTER_SECONDS,
    reason,
    sqlState,
    logLevel: LOGGED_AS_ERROR.has(reason) ? "error" : "warn",
  };
}

export {
  SERVICE_BUSY_CODE,
  SERVICE_BUSY_MESSAGE,
  SERVICE_BUSY_RETRY_AFTER_SECONDS,
  databaseBusyAnswer,
  pgBouncerRefusal,
};
export type { DatabaseBusyAnswer, DatabaseBusyReason, PgBouncerRefusal };
