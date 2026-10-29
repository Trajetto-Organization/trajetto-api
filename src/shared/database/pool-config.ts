/**
 * The connection pool settings carried by a DATABASE_URL, for the `pg` Pool
 * behind `@prisma/adapter-pg` (Prisma 7).
 *
 * Prisma 6 read its pool settings from the query string of DATABASE_URL.
 * The `pg` driver ignores every one of them: given the URL alone, the API
 * would run with pg's defaults — 10 connections for the readiness probe that
 * must hold one, and NO timeout for a request waiting on a full pool, which
 * then waits forever instead of failing after `pool_timeout`. So each
 * parameter is read here and handed to the Pool explicitly. The URL format
 * does not change: the environments typed in Dokploy keep working as they
 * are (docs/arquitetura.md, "Conexão com o Postgres").
 *
 * | URL parameter (seconds)        | pg setting                          | When absent      |
 * | ------------------------------ | ----------------------------------- | ---------------- |
 * | `connection_limit`             | Pool `max`                          | 10 (pg)          |
 * | `pool_timeout`                 | Pool `connectionTimeoutMillis`      | 10 s (Prisma 6)  |
 * | `connect_timeout`              | Client `connectionTimeoutMillis`    | 5 s (Prisma 6)   |
 * | `socket_timeout`               | Client `query_timeout`              | none (Prisma 6)  |
 * | `max_idle_connection_lifetime` | Pool `idleTimeoutMillis`            | 300 s (Prisma 6) |
 * | `max_connection_lifetime`      | Pool `maxLifetimeSeconds`           | none (Prisma 6)  |
 * | `schema`                       | adapter `schema`                    | public           |
 * | `options` (statement_timeout…) | sent at connect, + `TimeZone=UTC`   | `TimeZone=UTC`   |
 *
 * `0` keeps Prisma 6's meaning, "no limit", for the timeouts. pg-pool applies
 * its `connectionTimeoutMillis` both to waiting for a free connection and to
 * opening a new one, and the Client of pg-driver.ts adds `connect_timeout` to
 * the opening alone: a connect gives up at the smaller of the two. That is
 * Prisma 6's behaviour too — its `pool_timeout` bounded the whole checkout,
 * connect included (measured: pool_timeout 1 s and connect_timeout 4 s gave
 * P2024 at 1 s) — so a `connect_timeout` above `pool_timeout` has no effect.
 *
 * The Prisma-only parameters are removed from the connection string handed
 * to pg; the rest (`options`, `sslmode`, `application_name`…) goes through.
 *
 * Every session also runs in UTC, whatever the server, database or role
 * default: `-c TimeZone=UTC` is appended to the URL's `options` (see
 * sessionOptions below for why, and for the one case it is not).
 */

interface DatabasePoolSettings {
  /** The URL without the parameters read here, for `pg`. */
  connectionString: string;

  /** Postgres schema the queries are written against. */
  schema: string | undefined;

  /** Connections the pool may hold open. */
  max: number;

  /** Longest wait for a free connection; 0 waits forever. */
  poolTimeoutMs: number;

  /**
   * Longest wait to open a new connection; 0 waits forever. pg-pool's
   * `poolTimeoutMs` bounds the opening as well, so the smaller one wins.
   */
  connectTimeoutMs: number;

  /** Longest wait for a query's answer, client side; undefined has none. */
  queryTimeoutMs: number | undefined;

  /** An idle connection is closed after this long. */
  idleTimeoutMs: number;

  /** A connection is retired after this many seconds; 0 never. */
  maxLifetimeSeconds: number;
}

/** pg's own default pool size. */
const DEFAULT_MAX_CONNECTIONS = 10;

/** Prisma 6's defaults, kept so a URL without the parameter behaves as before. */
const DEFAULT_POOL_TIMEOUT_SECONDS = 10;
const DEFAULT_CONNECT_TIMEOUT_SECONDS = 5;
const DEFAULT_IDLE_LIFETIME_SECONDS = 300;

/** Read here and never sent to pg (which would ignore them anyway). */
const PRISMA_ONLY_PARAMETERS = [
  "connection_limit",
  "pool_timeout",
  "connect_timeout",
  "socket_timeout",
  "max_idle_connection_lifetime",
  "max_connection_lifetime",
  "schema",
  "pgbouncer",
  "statement_cache_size",
] as const;

/**
 * The session zone every connection asks for at startup.
 *
 * The schema's DateTime columns are `timestamp(3)` WITHOUT time zone holding
 * UTC, and raw SQL meets them with `now()` (a timestamptz): the queues claim
 * by `"availableAt" <= now()` and `"leaseExpiresAt" < now()`, the metrics
 * measure lag as `now() - MIN("availableAt")`, and upserts write `now()` into
 * `updated_at`, as a column's DEFAULT CURRENT_TIMESTAMP does. Postgres
 * converts between the two in the session's TimeZone, so all of that is
 * right only while the session is UTC: under America/Sao_Paulo a row the app
 * made due now is claimed three hours late, and a `now()` written by SQL
 * reads three hours early to the app. The Postgres images default to UTC,
 * which is the only reason it held so far (Prisma 6 had the same
 * dependency); a server, database or role set to another zone would have
 * broken it without an error. Pinned here, it no longer depends on how the
 * server is configured.
 *
 * Sent as a startup parameter, it costs no round trip, and a `SET TIME ZONE`
 * a caller runs on its own connection still wins for that session.
 */
const UTC_SESSION_OPTION = "-c TimeZone=UTC";

/**
 * An `options` string that already sets TimeZone: `-c TimeZone=…`,
 * `-cTimeZone=…` or `--TimeZone=…`, in any case (GUC names are
 * case-insensitive). `timezone_abbreviations` does not match.
 */
const SETS_TIME_ZONE = /(?:^|\s)(?:-c\s*|--)timezone=/i;

/**
 * The URL's `options` with the UTC session appended. A TimeZone the URL sets
 * itself is kept, and nothing is appended: Postgres applies the LAST `-c` of
 * a name, so appending would silently overrule what someone wrote on
 * purpose — the one way to run a client in another zone deliberately (to
 * prove a query does not depend on it, say). A URL that does so takes the
 * queues off UTC with it; the production URLs set no TimeZone.
 */
function sessionOptions(options: string | null): string {
  if (options === null || options.trim() === "") return UTC_SESSION_OPTION;

  if (SETS_TIME_ZONE.test(options)) return options;

  return `${options.trimEnd()} ${UTC_SESSION_OPTION}`;
}

function secondsParameter(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);

  if (raw === null || raw.trim() === "") return undefined;

  const value = Number(raw);

  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `DATABASE_URL: ${name} deve ser um número de segundos (recebido "${raw}")`,
    );
  }

  return value;
}

/**
 * The pool settings a database URL asks for. An empty URL gives pg's
 * defaults (the environment check of src/env refuses to boot without one;
 * this only keeps a module import from throwing in a script or a test).
 */
function poolSettingsFrom(
  databaseUrl: string | undefined,
): DatabasePoolSettings {
  if (!databaseUrl) {
    return {
      connectionString: "",
      schema: undefined,
      max: DEFAULT_MAX_CONNECTIONS,
      poolTimeoutMs: DEFAULT_POOL_TIMEOUT_SECONDS * 1000,
      connectTimeoutMs: DEFAULT_CONNECT_TIMEOUT_SECONDS * 1000,
      queryTimeoutMs: undefined,
      idleTimeoutMs: DEFAULT_IDLE_LIFETIME_SECONDS * 1000,
      maxLifetimeSeconds: 0,
    };
  }

  const url = new URL(databaseUrl);

  const limit = secondsParameter(url, "connection_limit");

  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error(
      `DATABASE_URL: connection_limit deve ser um inteiro positivo (recebido "${limit}")`,
    );
  }

  const poolTimeout =
    secondsParameter(url, "pool_timeout") ?? DEFAULT_POOL_TIMEOUT_SECONDS;
  const connectTimeout =
    secondsParameter(url, "connect_timeout") ?? DEFAULT_CONNECT_TIMEOUT_SECONDS;
  const socketTimeout = secondsParameter(url, "socket_timeout");
  const idleLifetime =
    secondsParameter(url, "max_idle_connection_lifetime") ??
    DEFAULT_IDLE_LIFETIME_SECONDS;
  const maxLifetime = secondsParameter(url, "max_connection_lifetime") ?? 0;
  const schema = url.searchParams.get("schema") || undefined;

  for (const name of PRISMA_ONLY_PARAMETERS) url.searchParams.delete(name);

  // In the connection string, not in the Pool config: pg lets a URL's
  // `options` replace the config's, so this is the one place it cannot be
  // lost (sessionOptions).
  url.searchParams.set(
    "options",
    sessionOptions(url.searchParams.get("options")),
  );

  return {
    connectionString: url.toString(),
    schema,
    max: limit ?? DEFAULT_MAX_CONNECTIONS,
    poolTimeoutMs: Math.round(poolTimeout * 1000),
    connectTimeoutMs: Math.round(connectTimeout * 1000),
    // 0 is "no limit" in Prisma 6; pg reads 0 the same way, but undefined is
    // clearer in the config dump.
    queryTimeoutMs:
      socketTimeout === undefined || socketTimeout === 0
        ? undefined
        : Math.round(socketTimeout * 1000),
    // pg reads 0 as "never close an idle connection", Prisma 6 the same.
    idleTimeoutMs: Math.round(idleLifetime * 1000),
    maxLifetimeSeconds: Math.round(maxLifetime),
  };
}

export { PRISMA_ONLY_PARAMETERS, poolSettingsFrom };
export type { DatabasePoolSettings };
