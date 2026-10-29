import pg from "pg";

import type { DatabasePoolSettings } from "./pool-config";

/**
 * The `pg` Pool under Prisma 7's driver adapter, with the two things pg
 * does not do the way the API relies on.
 *
 * 1. Its own failures arrive as plain `Error`s. `@prisma/adapter-pg` maps
 *    four socket errors (refused, reset, DNS not found, timed out) and
 *    Postgres' SQLSTATEs to Prisma codes, and rethrows anything else
 *    untouched — so a full pool, a connection that died under a query and a
 *    query past `socket_timeout` reached the app as `new Error("timeout
 *    exceeded when trying to connect")` and friends, where Prisma 6 raised
 *    P2024, P1017 and P1008; and any other socket errno (EHOSTUNREACH,
 *    EAI_AGAIN, EPIPE…) as a PrismaClientKnownRequestError whose `code` is
 *    the errno, where Prisma 6 said the server was unreachable.
 *    isDatabaseUnavailable trusts error classes, never message text from an
 *    arbitrary error, so these are typed HERE, at the only place they can
 *    come from: what leaves this pool. Each carries why (`reason`), which
 *    says whether a statement may have reached the database — the audit
 *    trail retries a write only when it certainly did not.
 *
 * 2. A query past `query_timeout` leaves its connection checked out with the
 *    query still pending. pg-pool drops a connection released with an error,
 *    but Prisma 7 releases a transaction's connection without one after the
 *    ROLLBACK, so a connection whose peer went silent mid-transaction went
 *    back to the pool and failed the next request too — the failure mode
 *    withPoolReset existed for under Prisma 6 (P1017). The connection is
 *    closed at the timeout instead: whatever it was doing cannot be trusted.
 *    The same goes for a statement Postgres answered with a FATAL, which
 *    ends the session (endsTheConnection, below).
 */

/**
 * Why the database did not answer, and so whether a statement may have
 * reached it.
 *
 * - `pool-timeout`: no connection came free within `pool_timeout`.
 * - `connect-failed`: a new connection could not be opened — unreachable,
 *   timed out, or closed during the handshake.
 * - `connection-lost`: an open connection died, or was already dead, under a
 *   statement.
 * - `query-timeout`: a statement got no answer within `socket_timeout`.
 *
 * The first two sent nothing. The last two may have: a connection that dies
 * on the way back from a COMMIT reports the same as one that died before it.
 */
type DatabaseUnavailableReason =
  | "pool-timeout"
  | "connect-failed"
  | "connection-lost"
  | "query-timeout";

/** pg's and pg-pool's own messages for "no database right now". */
const UNAVAILABLE_MESSAGES = new Map<string, DatabaseUnavailableReason>([
  // pg-pool: no connection free within connectionTimeoutMillis (P2024 in 6).
  ["timeout exceeded when trying to connect", "pool-timeout"],
  // pg-pool: a new connection did not open within connectionTimeoutMillis.
  ["Connection terminated due to connection timeout", "connect-failed"],
  // pg Client: a new connection did not open within its own timeout.
  ["timeout expired", "connect-failed"],
  // The socket closed under a query (P1017 in 6), or after we closed it.
  // During the handshake it is typed as connect-failed instead (below).
  ["Connection terminated unexpectedly", "connection-lost"],
  ["Connection terminated", "connection-lost"],
  // query_timeout, i.e. socket_timeout (P1008 / P2010 "N/A" in 6).
  ["Query read timeout", "query-timeout"],
  // A query sent to a connection already known dead.
  ["Client was closed and is not queryable", "connection-lost"],
  [
    "Client has encountered a connection error and is not queryable",
    "connection-lost",
  ],
]);

/**
 * Socket errnos the adapter does not map, each meaning the network, the host
 * or the connection is gone: it maps only ENOTFOUND and ECONNREFUSED (P1001),
 * ECONNRESET (P1017) and ETIMEDOUT (P1008), and Prisma raises any other as
 * a PrismaClientKnownRequestError with the errno as its code — a 500.
 */
const UNMAPPED_SOCKET_ERRNOS = new Set([
  "EAI_AGAIN",
  "EAI_FAIL",
  "EHOSTUNREACH",
  "EHOSTDOWN",
  "ENETUNREACH",
  "ENETDOWN",
  "EADDRNOTAVAIL",
  "ECONNABORTED",
  "EPIPE",
]);

/** The syscalls that open a connection: an errno from them sent nothing. */
const CONNECT_SYSCALLS = new Set(["connect", "getaddrinfo"]);

/**
 * The database did not answer: the pool had no connection to give, a
 * connection could not be opened, or one died or went silent under a query.
 * Raised only by the pool built here, wrapping pg's own error as `cause`.
 *
 * It has no `code` on purpose: Prisma turns any error with one into a
 * PrismaClientKnownRequestError with that code, and the class would be lost.
 */
class DatabaseUnavailableError extends Error {
  // Declared here: the ES2020 lib the API compiles against has no
  // `ErrorOptions.cause`.
  readonly cause: Error;

  readonly reason: DatabaseUnavailableReason;

  constructor(cause: Error, reason: DatabaseUnavailableReason) {
    super(cause.message);
    this.name = "DatabaseUnavailableError";
    this.cause = cause;
    this.reason = reason;
  }
}

function unavailableReason(
  error: Error,
  connecting: boolean,
): DatabaseUnavailableReason | undefined {
  const { code, syscall } = error as { code?: unknown; syscall?: unknown };

  let reason: DatabaseUnavailableReason | undefined;

  if (code === undefined) {
    reason = UNAVAILABLE_MESSAGES.get(error.message);
  } else if (
    typeof code === "string" &&
    typeof syscall === "string" &&
    UNMAPPED_SOCKET_ERRNOS.has(code)
  ) {
    reason = CONNECT_SYSCALLS.has(syscall)
      ? "connect-failed"
      : "connection-lost";
  }

  // Nothing of the caller's is sent before the connection is open.
  return reason && connecting ? "connect-failed" : reason;
}

function typed(error: unknown, connecting: boolean): unknown {
  if (!(error instanceof Error) || error instanceof DatabaseUnavailableError) {
    return error;
  }

  const reason = unavailableReason(error, connecting);

  return reason ? new DatabaseUnavailableError(error, reason) : error;
}

/**
 * pg's own error, typed; anything else as it is. Postgres' errors and the
 * socket errors the adapter maps carry a `code` and are left to it (P1001,
 * P2037, P2002…).
 */
function typedDriverError(error: unknown): unknown {
  return typed(error, false);
}

/** The same, for a failure while a connection was being opened. */
function typedConnectError(error: unknown): unknown {
  return typed(error, true);
}

function rethrowTyped(error: unknown): never {
  throw typedDriverError(error);
}

/**
 * The severities with which Postgres ends the session that gets them: FATAL
 * ends this backend, PANIC every backend.
 */
const SESSION_ENDING_SEVERITIES = new Set(["FATAL", "PANIC"]);

/**
 * The SQLSTATEs of the server leaving (57P01 shutdown, 57P02 crash, 57P03
 * not accepting connections, 57P04 database dropped, 57P05 idle session
 * timeout) and of the connection itself failing (class 08).
 */
const SESSION_ENDING_SQLSTATE = /^(?:57P0[0-9A-Z]|08[0-9A-Z]{3})$/;

/**
 * Whether Postgres' answer to a statement means the connection it came on is
 * finished: a backend terminated in the middle of a COMMIT (a restart, a
 * failover, pg_terminate_backend) answers FATAL 57P01, then closes the
 * socket.
 *
 * pg rejects the statement on that answer and keeps the connection queryable
 * until it reads the socket's end. Prisma 7 releases a transaction's
 * connection without an error after a failed COMMIT, so the pool took it back
 * as healthy and handed it to the very next query, which failed as
 * `connection-lost` — a 503 for a request that came after the outage
 * (measured: 8 of 8 next queries at 0 ms or setImmediate, none at 20 ms,
 * pools of 1 and 10).
 *
 * The SQLSTATE is read as well as the severity: pg takes the severity from
 * the localized field, which a server with lc_messages in another language
 * may spell otherwise. Class 08 is also sent at ERROR for a malformed
 * protocol message (08P01); closing that connection costs one reconnect,
 * the cheap side of the trade.
 */
function endsTheConnection(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;

  const { severity, code } = error as { severity?: unknown; code?: unknown };

  if (typeof severity === "string" && SESSION_ENDING_SEVERITIES.has(severity)) {
    return true;
  }

  return typeof code === "string" && SESSION_ENDING_SQLSTATE.test(code);
}

type AnyFunction = (...args: unknown[]) => unknown;

function isPromise(value: unknown): value is Promise<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Promise<unknown>).then === "function"
  );
}

/**
 * A pg Client that opens connections within `connectTimeoutMs`, types what
 * fails while it does, and closes its connection when a query outlives
 * `query_timeout`.
 *
 * pg-pool also bounds the opening of a connection by its own timeout
 * (`pool_timeout`), so a connect gives up at the smaller of the two — as
 * under Prisma 6, whose pool_timeout covered the wait and the connect alike
 * (measured on both versions: pool_timeout 1 s with connect_timeout 4 s
 * gives up at 1 s, P2024 in 6).
 */
function clientClass(connectTimeoutMs: number): typeof pg.Client {
  return class DriverClient extends pg.Client {
    constructor(config?: string | pg.ClientConfig) {
      super(
        typeof config === "string"
          ? {
              connectionString: config,
              connectionTimeoutMillis: connectTimeoutMs,
            }
          : { ...config, connectionTimeoutMillis: connectTimeoutMs },
      );

      // A checked-out connection that dies emits "error" on the client; the
      // pool and the adapter listen only at times. Its queries fail on their
      // own, so an unheard "error" must not become an uncaught exception.
      this.on("error", () => {});

      // What fails while the connection opens failed before any statement
      // was sent. Typed here, where that is known: pg says "Connection
      // terminated unexpectedly" for a socket closed during the handshake
      // and for one closed under a query alike. pg-pool calls the callback
      // form.
      const connect = this.connect.bind(this) as AnyFunction;

      this.connect = ((callback?: unknown) => {
        if (typeof callback !== "function") {
          return (connect() as Promise<unknown>).catch((error: unknown) => {
            throw typedConnectError(error);
          });
        }

        return connect((error: unknown, ...rest: unknown[]) =>
          (callback as AnyFunction)(
            error ? typedConnectError(error) : error,
            ...rest,
          ),
        );
      }) as typeof this.connect;

      // Only the promise form: the callback form is pg-pool's `query`, which
      // already drops the connection on any error. The promise form is every
      // statement of a transaction, its COMMIT included: the adapter runs
      // them all through the checked-out connection's `query`.
      const query = this.query.bind(this) as AnyFunction;

      this.query = ((...args: unknown[]) => {
        const result = query(...args);

        if (!isPromise(result)) return result;

        return result.catch((error: unknown) => {
          if (
            (error instanceof Error &&
              error.message === "Query read timeout") ||
            endsTheConnection(error)
          ) {
            // end() marks the client as ending at once, before the adapter
            // gets to release it, so the pool drops it on release instead of
            // handing it out again. With a query still pending it destroys
            // the socket; after a FATAL it closes what Postgres is closing.
            void this.end().catch(() => {});
          }

          return rethrowTyped(error);
        });
      }) as typeof this.query;
    }
  };
}

/** The pool for one Prisma connection: built per `$connect`, ended by `$disconnect`. */
function createPool(settings: DatabasePoolSettings): pg.Pool {
  const pool = new pg.Pool({
    connectionString: settings.connectionString || undefined,
    max: settings.max,
    connectionTimeoutMillis: settings.poolTimeoutMs,
    idleTimeoutMillis: settings.idleTimeoutMs,
    maxLifetimeSeconds: settings.maxLifetimeSeconds,
    query_timeout: settings.queryTimeoutMs,
    // TCP keepalive with the OS idle time, as Prisma 6's driver had it.
    keepAlive: true,
    Client: clientClass(settings.connectTimeoutMs),
  });

  // An IDLE connection that dies (a restart, a terminated backend) is
  // removed by the pool before this runs; the next query opens a new one.
  // Without a listener, Node would treat the event as an uncaught error.
  pool.on("error", () => {});

  const connect = pool.connect.bind(pool) as AnyFunction;
  const query = pool.query.bind(pool) as AnyFunction;

  // Promise forms only, which is how the adapter calls them; pg-pool's own
  // `query` calls `connect` with a callback.
  pool.connect = ((...args: unknown[]) => {
    const result = connect(...args);

    return isPromise(result) ? result.catch(rethrowTyped) : result;
  }) as typeof pool.connect;

  pool.query = ((...args: unknown[]) => {
    const result = query(...args);

    return isPromise(result) ? result.catch(rethrowTyped) : result;
  }) as typeof pool.query;

  return pool;
}

export {
  DatabaseUnavailableError,
  UNMAPPED_SOCKET_ERRNOS,
  createPool,
  endsTheConnection,
  typedDriverError,
};
export type { DatabaseUnavailableReason };
