import pg from "pg";

import type { DatabasePoolSettings } from "./pool-config";

/**
 * The `pg` Pool under Prisma 7's driver adapter, with the two things pg
 * does not do the way the API relies on.
 *
 * 1. Its own failures arrive as plain `Error`s. `@prisma/adapter-pg` maps
 *    socket errors (refused, reset, DNS) and Postgres' SQLSTATEs to Prisma
 *    codes, and rethrows anything else untouched — so a full pool, a
 *    connection that died under a query and a query past `socket_timeout`
 *    reached the app as `new Error("timeout exceeded when trying to
 *    connect")` and friends, where Prisma 6 raised P2024, P1017 and P1008.
 *    isDatabaseUnavailable trusts error classes, never message text from an
 *    arbitrary error, so these are typed HERE, at the only place they can
 *    come from: what leaves this pool.
 *
 * 2. A query past `query_timeout` leaves its connection checked out with the
 *    query still pending. pg-pool drops a connection released with an error,
 *    but Prisma 7 releases a transaction's connection without one after the
 *    ROLLBACK, so a connection whose peer went silent mid-transaction went
 *    back to the pool and failed the next request too — the failure mode
 *    withPoolReset existed for under Prisma 6 (P1017). The connection is
 *    closed at the timeout instead: whatever it was doing cannot be trusted.
 */

/** pg's and pg-pool's own messages for "no database right now". */
const UNAVAILABLE_MESSAGES = new Set([
  // pg-pool: no connection free within connectionTimeoutMillis (P2024 in 6).
  "timeout exceeded when trying to connect",
  // pg-pool: a new connection did not open within connectionTimeoutMillis.
  "Connection terminated due to connection timeout",
  // pg Client: a new connection did not open within its own timeout.
  "timeout expired",
  // The socket closed under a query (P1017 in 6), or after we closed it.
  "Connection terminated unexpectedly",
  "Connection terminated",
  // query_timeout, i.e. socket_timeout (P1008 / P2010 "N/A" in 6).
  "Query read timeout",
  // A query sent to a connection already known dead.
  "Client was closed and is not queryable",
  "Client has encountered a connection error and is not queryable",
]);

/**
 * The database did not answer: the pool had no connection to give, a
 * connection could not be opened, or one died or went silent under a query.
 * Raised only by the pool built here, wrapping pg's own error as `cause`.
 */
class DatabaseUnavailableError extends Error {
  // Declared here: the ES2020 lib the API compiles against has no
  // `ErrorOptions.cause`.
  readonly cause: Error;

  constructor(cause: Error) {
    super(cause.message);
    this.name = "DatabaseUnavailableError";
    this.cause = cause;
  }
}

/**
 * pg's own error, typed; anything else as it is. Postgres' errors and socket
 * errors carry a `code` and are left for the adapter to map (P1001, P2002…).
 */
function typedDriverError(error: unknown): unknown {
  if (
    error instanceof Error &&
    !(error instanceof DatabaseUnavailableError) &&
    (error as { code?: unknown }).code === undefined &&
    UNAVAILABLE_MESSAGES.has(error.message)
  ) {
    return new DatabaseUnavailableError(error);
  }

  return error;
}

function rethrowTyped(error: unknown): never {
  throw typedDriverError(error);
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
 * A pg Client that opens connections within `connectTimeoutMs` (the pool's
 * own timeout is the wait for a free connection) and closes its connection
 * when a query outlives `query_timeout`.
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

      // Only the promise form: the callback form is pg-pool's `query`, which
      // already drops the connection on any error.
      const query = this.query.bind(this) as AnyFunction;

      this.query = ((...args: unknown[]) => {
        const result = query(...args);

        if (!isPromise(result)) return result;

        return result.catch((error: unknown) => {
          if (
            error instanceof Error &&
            error.message === "Query read timeout"
          ) {
            // With a query still pending, end() destroys the socket; the
            // pool then sees the connection ending and drops it on release.
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

export { DatabaseUnavailableError, createPool, typedDriverError };
