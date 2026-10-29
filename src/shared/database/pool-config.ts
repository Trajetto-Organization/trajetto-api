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
 * | `options` (statement_timeout…) | sent to Postgres at connect, as is  | —                |
 *
 * `0` keeps Prisma 6's meaning, "no limit", for the timeouts. pg-pool applies
 * one `connectionTimeoutMillis` both to waiting for a free connection and to
 * opening a new one; database-client.ts gives the Client its own connect
 * timeout so the two stay apart, as `pool_timeout` and `connect_timeout` were.
 *
 * The Prisma-only parameters are removed from the connection string handed
 * to pg; the rest (`options`, `sslmode`, `application_name`…) goes through.
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

  /** Longest wait to open a new connection; 0 waits forever. */
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
