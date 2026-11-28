import { promises as dns } from "node:dns";
import { isIP } from "node:net";

import pg from "pg";
import { Prisma } from "@prisma/client";

import {
  CONSOLE_DATABASE,
  PGBOUNCER_MAX_INSTANCES,
  PROBE_ALIAS_SUFFIX,
  type PgBouncerStatsConfig,
} from "@/shared/health/pgbouncer-stats-config";
import { logger } from "@/shared/logging/logger";

/**
 * PgBouncer's own numbers (plano-escala F4-36): its pools, its traffic and
 * its server connections, read from its console by the stats login.
 *
 * From wave 17 the runtime reaches Postgres through trajetto-pgbouncer, and
 * what fills first under load is no longer the API's pool but PgBouncer's:
 * clients waiting for a server connection (cl_waiting, maxwait) are the
 * 503s of query_wait_timeout a few seconds later, and the server
 * connections against max_db_connections are the budget of ADR 0008. None
 * of it is visible from Postgres.
 *
 * Who reads, and how:
 *  - only the process with the cron, once a minute, in the ops heartbeat
 *    (cluster-sample.ts), never a request: the console is read by one
 *    process, the alerts judge it, and the minute's cluster row of
 *    ops_sample carries it to every replica's /health/metrics
 *    (readLatestPgBouncerSample);
 *  - by `pgbouncer_stats`, the login PgBouncer lets run SHOW and nothing
 *    else (infra/pgbouncer/entrypoint.sh, stats_users). The API never gets
 *    the admin login: PAUSE, RESUME, KILL and SHUTDOWN stay with the owner,
 *    in the console inside the container (docs/deploy.md, PgBouncer). The
 *    env check refuses any other login in PGBOUNCER_STATS_URL, and the
 *    commands sent are the closed list below;
 *  - every task: PGBOUNCER_STATS_HOSTS names `tasks.<App Name>`, which
 *    Docker's DNS answers with the address of each task of the service (the
 *    App Name alone is the virtual IP, one task at a time). Each address is
 *    read on the stats URL's port, with the URL's login. Without the
 *    variable, the URL's own host.
 *
 * Fail-open: unset, it reads nothing and answers null; a task that does not
 * answer in 2 s is a `down` instance with the reason (never the URL), and
 * the alert says so. Nothing here throws.
 */

const log = logger.child({ component: "pgbouncer-metrics" });

/**
 * The only commands sent to the console, in this order. All are SHOW: the
 * stats login could not run anything else anyway (PgBouncer answers "admin
 * access needed"), and this list keeps the API from trying.
 */
const PGBOUNCER_STATS_COMMANDS = [
  "SHOW POOLS",
  "SHOW STATS",
  "SHOW DATABASES",
] as const;

type PgBouncerStatsCommand = (typeof PGBOUNCER_STATS_COMMANDS)[number];

/** Connect and each command: well inside the heartbeat's minute. */
const PGBOUNCER_READ_TIMEOUT_MS = 2_000;

interface PgBouncerPool {
  database: string;
  user: string;
  cl_active: number;
  cl_waiting: number;
  sv_active: number;
  sv_idle: number;
  sv_used: number;
  /** How long the oldest waiting client has waited, in seconds. */
  maxwait_seconds: number;
  pool_mode: string | null;
}

interface PgBouncerDatabaseState {
  name: string;
  pool_size: number;
  /** max_db_connections; 0 is no ceiling. */
  max_connections: number;
  current_connections: number;
  paused: boolean;
  disabled: boolean;
}

interface PgBouncerTraffic {
  database: string;
  /** Per second, averaged by PgBouncer over its stats period (60 s). */
  xact_per_second: number;
  query_per_second: number;
  /** Microseconds, averaged the same way. */
  avg_xact_time_us: number;
  avg_query_time_us: number;
  avg_wait_time_us: number;
}

interface PgBouncerInstance {
  address: string;
  status: "up" | "down";
  /** Why it did not answer: a code or PgBouncer's words, never the URL. */
  error: string | null;
  pools: PgBouncerPool[];
  databases: PgBouncerDatabaseState[];
  stats: PgBouncerTraffic[];
}

interface PgBouncerTotals {
  instances: number;
  instances_up: number;
  cl_active: number;
  cl_waiting: number;
  maxwait_seconds: number;
  /** The pool (database/user) of that wait; null without one. */
  maxwait_pool: string | null;
  /** Every server connection, the readiness alias's included. */
  server_connections: number;
  /**
   * The busiest database against its max_db_connections, in percent, and
   * which database it is; null when none has a ceiling. The readiness
   * alias (`<db>_probe`) is left out: its ceiling of 2 is its own pool,
   * full with the probe's login and the auth_query's connection on any
   * quiet minute, and not the budget this number pages on.
   */
  server_usage_percent: number | null;
  server_usage_database: string | null;
  paused_databases: number;
}

interface PgBouncerMetrics {
  status: "up" | "partial" | "down";
  read_at: string;
  /** Why nothing was read at all (a name the DNS does not know). */
  error: string | null;
  instances: PgBouncerInstance[];
  totals: PgBouncerTotals;
}

/** What /health/metrics shows: the cron's newest reading, and when. */
type PgBouncerSample = PgBouncerMetrics & { sampled_at: string };

interface ConsoleConnection {
  query: (text: string) => Promise<{ rows: Array<Record<string, unknown>> }>;
  end: () => Promise<void>;
}

interface PgBouncerReadDeps {
  /** Every address of a name (Docker's DNS: one per task for tasks.X). */
  lookup: (host: string) => Promise<string[]>;

  /** An open console connection on that connection string. */
  connect: (connectionString: string) => Promise<ConsoleConnection>;

  now: () => Date;
}

function numberOf(value: unknown): number {
  const number = Number(value);

  return Number.isFinite(number) ? number : 0;
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

/**
 * Whether `name` is the readiness alias of another database of the list
 * (`<db>_probe`, as the image names it). Its pool of 2 is full on a quiet
 * minute (the probe's login, and the auth_query's connection PgBouncer
 * keeps in the same database for pgbouncer_auth; two probes that overlap
 * do it too), so it would read 100% of its own ceiling while the real pool
 * idles.
 */
function isProbeAlias(name: string, names: ReadonlySet<string>): boolean {
  return (
    name.endsWith(PROBE_ALIAS_SUFFIX) &&
    names.has(name.slice(0, -PROBE_ALIAS_SUFFIX.length))
  );
}

function isApplicationDatabase(row: Record<string, unknown>, key: string) {
  return textOf(row[key]) !== CONSOLE_DATABASE;
}

function poolsFrom(rows: Array<Record<string, unknown>>): PgBouncerPool[] {
  return rows
    .filter((row) => isApplicationDatabase(row, "database"))
    .map((row) => ({
      database: textOf(row.database),
      user: textOf(row.user),
      cl_active: numberOf(row.cl_active),
      cl_waiting: numberOf(row.cl_waiting),
      sv_active: numberOf(row.sv_active),
      sv_idle: numberOf(row.sv_idle),
      sv_used: numberOf(row.sv_used),
      maxwait_seconds:
        numberOf(row.maxwait) + numberOf(row.maxwait_us) / 1_000_000,
      pool_mode: row.pool_mode == null ? null : textOf(row.pool_mode),
    }));
}

function databasesFrom(
  rows: Array<Record<string, unknown>>,
): PgBouncerDatabaseState[] {
  return rows
    .filter((row) => isApplicationDatabase(row, "name"))
    .map((row) => ({
      name: textOf(row.name),
      pool_size: numberOf(row.pool_size),
      max_connections: numberOf(row.max_connections),
      current_connections: numberOf(row.current_connections),
      paused: numberOf(row.paused) > 0,
      disabled: numberOf(row.disabled) > 0,
    }));
}

function statsFrom(rows: Array<Record<string, unknown>>): PgBouncerTraffic[] {
  return rows
    .filter((row) => isApplicationDatabase(row, "database"))
    .map((row) => ({
      database: textOf(row.database),
      xact_per_second: numberOf(row.avg_xact_count),
      query_per_second: numberOf(row.avg_query_count),
      avg_xact_time_us: numberOf(row.avg_xact_time),
      avg_query_time_us: numberOf(row.avg_query_time),
      avg_wait_time_us: numberOf(row.avg_wait_time),
    }));
}

/** A failure as a short reason: PgBouncer's words, or the errno. */
function reasonOf(error: unknown): string {
  if (error instanceof Error) {
    const { code } = error as { code?: unknown };

    // pg's DatabaseError carries the server's SQLSTATE in `code`: the words
    // say more ("SASL authentication failed"). A socket error's code is the
    // errno, which is the reason.
    if (typeof code === "string" && !/^[0-9A-Z]{5}$/.test(code)) return code;

    return error.message.slice(0, 200);
  }

  return "erro desconhecido";
}

/** The stats URL pointed at one address, the rest as it is. */
function urlFor(base: string, address: string): string {
  const url = new URL(base);

  url.hostname = isIP(address) === 6 ? `[${address}]` : address;

  return url.toString();
}

function defaultDeps(): PgBouncerReadDeps {
  return {
    lookup: async (host) =>
      (await dns.lookup(host, { all: true })).map((entry) => entry.address),
    connect: async (connectionString) => {
      const client = new pg.Client({
        connectionString,
        connectionTimeoutMillis: PGBOUNCER_READ_TIMEOUT_MS,
        query_timeout: PGBOUNCER_READ_TIMEOUT_MS,
      });

      // An error after the read (the task going away) must not take the
      // process down: the next minute reads again.
      client.on("error", () => {});
      await client.connect();

      return {
        query: (text) => client.query(text),
        end: () => client.end(),
      };
    },
    now: () => new Date(),
  };
}

async function readInstance(
  address: string,
  url: string,
  deps: PgBouncerReadDeps,
): Promise<PgBouncerInstance> {
  const instance: PgBouncerInstance = {
    address,
    status: "down",
    error: null,
    pools: [],
    databases: [],
    stats: [],
  };
  let connection: ConsoleConnection | null = null;

  try {
    connection = await deps.connect(urlFor(url, address));

    const rows = {} as Record<
      PgBouncerStatsCommand,
      Array<Record<string, unknown>>
    >;

    // One after the other, on one connection: the console is single-file.
    for (const command of PGBOUNCER_STATS_COMMANDS) {
      rows[command] = (await connection.query(command)).rows;
    }

    instance.pools = poolsFrom(rows["SHOW POOLS"]);
    instance.stats = statsFrom(rows["SHOW STATS"]);
    instance.databases = databasesFrom(rows["SHOW DATABASES"]);
    instance.status = "up";
  } catch (error) {
    instance.error = reasonOf(error);
  } finally {
    await connection?.end().catch(() => {});
  }

  return instance;
}

function totalsOf(instances: PgBouncerInstance[]): PgBouncerTotals {
  const up = instances.filter((instance) => instance.status === "up");
  const pools = up.flatMap((instance) => instance.pools);
  const databases = up.flatMap((instance) => instance.databases);

  let maxwait = 0;
  let maxwaitPool: string | null = null;

  for (const pool of pools) {
    if (pool.maxwait_seconds > maxwait) {
      maxwait = pool.maxwait_seconds;
      maxwaitPool = `${pool.database}/${pool.user}`;
    }
  }

  let usage: number | null = null;
  let usageDatabase: string | null = null;
  const names = new Set(databases.map((database) => database.name));

  for (const database of databases) {
    if (database.max_connections <= 0 || isProbeAlias(database.name, names)) {
      continue;
    }

    const percent =
      (database.current_connections / database.max_connections) * 100;

    if (usage === null || percent > usage) {
      usage = Math.round(percent * 10) / 10;
      usageDatabase = database.name;
    }
  }

  return {
    instances: instances.length,
    instances_up: up.length,
    cl_active: pools.reduce((total, pool) => total + pool.cl_active, 0),
    cl_waiting: pools.reduce((total, pool) => total + pool.cl_waiting, 0),
    maxwait_seconds: Math.round(maxwait * 1000) / 1000,
    maxwait_pool: maxwaitPool,
    server_connections: databases.reduce(
      (total, database) => total + database.current_connections,
      0,
    ),
    server_usage_percent: usage,
    server_usage_database: usageDatabase,
    paused_databases: databases.filter((database) => database.paused).length,
  };
}

/**
 * Every PgBouncer task's console, read once. Null when not configured;
 * never throws.
 */
async function readPgBouncerMetrics(
  config: PgBouncerStatsConfig | null,
  overrides: Partial<PgBouncerReadDeps> = {},
): Promise<PgBouncerMetrics | null> {
  if (!config) return null;

  const deps = { ...defaultDeps(), ...overrides };
  const readAt = deps.now().toISOString();

  let addresses: string[] = [];
  let lookupError: string | null = null;

  try {
    const names = config.hosts.length
      ? config.hosts
      : [new URL(config.url).hostname.replace(/^\[|\]$/g, "")];

    for (const name of names) {
      const found = isIP(name) ? [name] : await deps.lookup(name);

      for (const address of found) {
        if (!addresses.includes(address)) addresses.push(address);
      }
    }

    addresses = addresses.slice(0, PGBOUNCER_MAX_INSTANCES);
  } catch (error) {
    lookupError = reasonOf(error);
  }

  if (addresses.length === 0) {
    const error = lookupError ?? "nenhum endereço";

    log.warn({ error }, "pgbouncer stats: no address to read");

    return {
      status: "down",
      read_at: readAt,
      error,
      instances: [],
      totals: totalsOf([]),
    };
  }

  const instances: PgBouncerInstance[] = [];

  for (const address of addresses) {
    instances.push(await readInstance(address, config.url, deps));
  }

  const up = instances.filter((instance) => instance.status === "up").length;

  for (const instance of instances) {
    if (instance.status === "down") {
      log.warn(
        { address: instance.address, error: instance.error },
        "pgbouncer stats: instance did not answer",
      );
    }
  }

  return {
    status: up === instances.length ? "up" : up === 0 ? "down" : "partial",
    read_at: readAt,
    error: lookupError,
    instances,
    totals: totalsOf(instances),
  };
}

/** How old a cluster row /health/metrics still shows: five minutes. */
const PGBOUNCER_SAMPLE_MAX_AGE_MS = 5 * 60 * 1000;

type Client = Pick<Prisma.TransactionClient, "$queryRaw">;

/**
 * The cron's newest reading, from the newest cluster row of ops_sample of
 * the last five minutes, with its time; null when that row has none (not
 * configured, or the series switched off) or nothing could be read.
 * One statement on the ts index; never throws.
 */
async function readLatestPgBouncerSample(
  client: Client,
  now: Date = new Date(),
): Promise<PgBouncerSample | null> {
  try {
    const since = new Date(now.getTime() - PGBOUNCER_SAMPLE_MAX_AGE_MS);
    const [row] = await client.$queryRaw<
      Array<{ ts: Date | string; pgbouncer: PgBouncerMetrics | null }>
    >(Prisma.sql`
      SELECT ts, metrics->'pgbouncer' AS pgbouncer
      FROM ops_sample
      WHERE ts > ${since} AND role = 'cluster'
      ORDER BY ts DESC
      LIMIT 1
    `);

    if (!row?.pgbouncer) return null;

    return { ...row.pgbouncer, sampled_at: new Date(row.ts).toISOString() };
  } catch (error) {
    log.warn({ err: error }, "pgbouncer sample read failed");

    return null;
  }
}

export {
  PGBOUNCER_READ_TIMEOUT_MS,
  PGBOUNCER_SAMPLE_MAX_AGE_MS,
  PGBOUNCER_STATS_COMMANDS,
  readLatestPgBouncerSample,
  readPgBouncerMetrics,
};
export type {
  ConsoleConnection,
  PgBouncerInstance,
  PgBouncerMetrics,
  PgBouncerReadDeps,
  PgBouncerSample,
};
