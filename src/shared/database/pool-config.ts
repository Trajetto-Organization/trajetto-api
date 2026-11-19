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
 *
 * A URL through PgBouncer (port 6432 or `pgbouncer=true`, plano-escala
 * F4-31) is pooled, and three things change; pooledUrlProblem and
 * POOLED_MAX_CONNECTION_LIFETIME_SECONDS below say why:
 *
 *  - its `options` carry TimeZone and nothing else: the ceilings come from
 *    the login's ALTER ROLE (infra/sql/20-runtime-roles.sql), and a side
 *    pool's own statement ceiling is not appended either;
 *  - its connections are retired after 60 s unless the URL asks for less;
 *  - the application_name still goes as a startup parameter (pg-driver.ts),
 *    which PgBouncer tracks and sets on the server connection of each of
 *    the client's transactions.
 */

import { throughPgBouncer } from "./pgbouncer-url";

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

  /**
   * The name the pool's sessions carry in pg_stat_activity unless the URL
   * names one (plano-escala F3-02; runtimeApplicationName below): never
   * read from the URL here, set by the runtime's pools as an override.
   * Absent, pg-driver.ts's default.
   */
  applicationName?: string;
}

/**
 * How long a connection through PgBouncer lives (plano-escala F4-31).
 *
 * SIGTERM is SHUTDOWN WAIT_FOR_CLIENTS for PgBouncer: the old task of a
 * start-first rolling of trajetto-pgbouncer stops taking clients and serves
 * the ones it has until they leave, and Swarm kills it at the Stop Grace
 * Period, 90 s, with whatever is still on it (infra/pgbouncer/entrypoint.sh).
 * A pool that kept its connections for the 5 min of
 * max_idle_connection_lifetime would still be on the old task then, and
 * every statement in flight on it would fail. Retired at 60 s, a connection
 * is gone within a minute plus the statement it runs (the runtime roles'
 * statement_timeout is 30 s): inside the 90 s, and the pool's next
 * connection opens on the new task. It is also how a retarget (failover)
 * or a second PgBouncer replica reaches every client within a minute. A
 * login to PgBouncer opens no Postgres backend, so a few reconnects a
 * minute per process cost next to nothing.
 */
const POOLED_MAX_CONNECTION_LIFETIME_SECONDS = 60;

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

/**
 * The names of the settings an `options` string sets, in lower case, or
 * null when it holds anything else: Postgres reads `-c name=value`,
 * `-cname=value` and `--name=value`, separated by spaces (a backslash
 * escapes one).
 */
function optionSettings(options: string): string[] | null {
  const tokens = options
    .trim()
    .split(/(?<!\\)\s+/)
    .filter((token) => token !== "");
  const names: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    let setting: string | undefined;

    if (token === "-c") {
      index += 1;
      setting = tokens[index];
    } else if (token.startsWith("--") || token.startsWith("-c")) {
      setting = token.slice(2);
    }

    const name = setting?.split("=")[0];

    if (!setting?.includes("=") || !name) return null;

    names.push(name.toLowerCase());
  }

  return names;
}

/**
 * Why a URL through PgBouncer cannot be used as it is, or null
 * (plano-escala F4-31). Null for a direct URL, whatever it carries.
 *
 * PgBouncer in transaction mode hands each transaction to whichever server
 * connection is free, so a setting either travels with every client
 * (PgBouncer does that for the few it tracks: TimeZone, application_name…)
 * or belongs to the login. The ceilings belong to the login: each runtime
 * role carries its statement_timeout, lock_timeout and
 * idle_in_transaction_session_timeout by ALTER ROLE (F3-19). In `options`
 * they are worse than useless: PgBouncer refuses the connection
 * ("unsupported startup parameter in options"), so a URL copied from the
 * direct one, ceilings included, would fail every query of the process.
 * The boot refuses it (env-schema), and so does the pool, saying what to
 * take out.
 *
 * max_connection_lifetime, when the URL sets it, stays within the 60 s a
 * rolling of PgBouncer needs (POOLED_MAX_CONNECTION_LIFETIME_SECONDS): 0,
 * "never", or more would leave connections on the old task until it is
 * killed.
 */
function pooledUrlProblem(databaseUrl: string): string | null {
  if (!throughPgBouncer(databaseUrl)) return null;

  const url = new URL(databaseUrl);
  const options = url.searchParams.get("options");

  if (options !== null && options.trim() !== "") {
    const names = optionSettings(options);
    const others = names?.filter((name) => name !== "timezone") ?? [];

    if (!names || others.length > 0) {
      const found = names ? others.join(", ") : `"${options.trim()}"`;

      return (
        "uma URL pelo PgBouncer (porta 6432 ou pgbouncer=true) leva no " +
        "options só o TimeZone: os tetos (statement_timeout, lock_timeout e " +
        "idle_in_transaction_session_timeout) vêm do ALTER ROLE do login " +
        "(infra/sql/20-runtime-roles.sql), e o PgBouncer recusa a conexão " +
        `com eles. Tire do options: ${found}`
      );
    }
  }

  const raw = url.searchParams.get("max_connection_lifetime");

  if (raw !== null && raw.trim() !== "") {
    const value = Number(raw);

    if (
      !Number.isFinite(value) ||
      value <= 0 ||
      value > POOLED_MAX_CONNECTION_LIFETIME_SECONDS
    ) {
      return (
        "max_connection_lifetime de uma URL pelo PgBouncer vai de 1 a " +
        `${POOLED_MAX_CONNECTION_LIFETIME_SECONDS} s (recebido "${raw}"): no ` +
        "rolling do PgBouncer, a tarefa antiga espera os clientes saírem " +
        "dentro do Stop Grace Period de 90 s. Sem o parâmetro, vale " +
        `${POOLED_MAX_CONNECTION_LIFETIME_SECONDS} s`
      );
    }
  }

  return null;
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
 * A pool's own statement ceiling, over the URL's (plano-escala F3-16): the
 * read bulkhead's 10 s and the batch pool's 30 min, on the same URL as the
 * runtime until each gets a login of its own.
 */
interface StatementCeiling {
  /** Sent as `-c statement_timeout=<ms>` after the URL's own options. */
  statementTimeoutMs: number;
}

/**
 * How much longer than the statement ceiling the client waits for an
 * answer: Postgres cancels the statement first and says so, and only a
 * connection that went silent past that is cut by the client.
 */
const QUERY_TIMEOUT_MARGIN_MS = 30_000;

/** Which of the runtime's pools a session belongs to, besides the main one. */
type RuntimePool = "read" | "batch" | "probe" | "replica";

/**
 * The application_name of a runtime pool (plano-escala F3-02):
 * `trajetto-<role>`, plus `-read`, `-batch`, `-replica` (the standby, F4-41)
 * or `-probe` for the side pools and the readiness probe. With roles, pg_stat_activity tells the worker's
 * sessions from the api's and the bulkhead from the requests: the
 * connection budget per role (ADR 0008) is then read, not guessed. It only
 * fills the gap: an application_name in the URL wins (pg reads the
 * connection string over the config). Without a role (an invalid
 * PROCESS_ROLE, which the env check refuses anyway), the default name.
 */
function runtimeApplicationName(
  role: string | undefined,
  pool?: RuntimePool,
): string | undefined {
  if (!role) return undefined;

  return pool ? `trajetto-${role}-${pool}` : `trajetto-${role}`;
}

/**
 * The pool settings a database URL asks for. An empty URL gives pg's
 * defaults (the environment check of src/env refuses to boot without one;
 * this only keeps a module import from throwing in a script or a test).
 *
 * With a `ceiling`, the pool's statements get that statement_timeout
 * instead of the URL's (Postgres applies the last `-c` of a name), and a
 * `socket_timeout` shorter than it is raised past it: a 60 s socket
 * timeout would cut the batch pool's half-hour VACUUM at one minute.
 *
 * A URL through PgBouncer gets neither: its ceiling is its login's
 * (trajetto_read carries the bulkhead's 10 s), and PgBouncer would refuse
 * the connection with one in `options`. A side pool that falls back to a
 * pooled DATABASE_URL therefore runs with that login's ceiling. Its
 * connections are retired after 60 s unless the URL asks for less, and a
 * URL pooledUrlProblem refuses throws here too.
 */
function poolSettingsFrom(
  databaseUrl: string | undefined,
  ceiling?: StatementCeiling,
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
  const pooled = throughPgBouncer(databaseUrl);
  const pooledProblem = pooledUrlProblem(databaseUrl);

  if (pooledProblem) throw new Error(`DATABASE_URL: ${pooledProblem}`);

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
  const maxLifetime =
    secondsParameter(url, "max_connection_lifetime") ??
    (pooled ? POOLED_MAX_CONNECTION_LIFETIME_SECONDS : 0);
  const schema = url.searchParams.get("schema") || undefined;

  for (const name of PRISMA_ONLY_PARAMETERS) url.searchParams.delete(name);

  // In the connection string, not in the Pool config: pg lets a URL's
  // `options` replace the config's, so this is the one place it cannot be
  // lost (sessionOptions).
  const options = sessionOptions(url.searchParams.get("options"));

  url.searchParams.set(
    "options",
    ceiling && !pooled
      ? `${options} -c statement_timeout=${Math.round(ceiling.statementTimeoutMs)}`
      : options,
  );

  const queryTimeoutMs =
    socketTimeout === undefined || socketTimeout === 0
      ? undefined
      : Math.round(socketTimeout * 1000);

  return {
    connectionString: url.toString(),
    schema,
    max: limit ?? DEFAULT_MAX_CONNECTIONS,
    poolTimeoutMs: Math.round(poolTimeout * 1000),
    connectTimeoutMs: Math.round(connectTimeout * 1000),
    // 0 is "no limit" in Prisma 6; pg reads 0 the same way, but undefined is
    // clearer in the config dump.
    queryTimeoutMs:
      ceiling && !pooled && queryTimeoutMs !== undefined
        ? Math.max(
            queryTimeoutMs,
            Math.round(ceiling.statementTimeoutMs) + QUERY_TIMEOUT_MARGIN_MS,
          )
        : queryTimeoutMs,
    // pg reads 0 as "never close an idle connection", Prisma 6 the same.
    idleTimeoutMs: Math.round(idleLifetime * 1000),
    maxLifetimeSeconds: Math.round(maxLifetime),
  };
}

export {
  POOLED_MAX_CONNECTION_LIFETIME_SECONDS,
  PRISMA_ONLY_PARAMETERS,
  QUERY_TIMEOUT_MARGIN_MS,
  poolSettingsFrom,
  pooledUrlProblem,
  runtimeApplicationName,
};
export type { DatabasePoolSettings, RuntimePool, StatementCeiling };
