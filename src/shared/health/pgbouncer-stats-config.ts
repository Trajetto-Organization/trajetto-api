import { isIP } from "node:net";

/**
 * PGBOUNCER_STATS_URL and PGBOUNCER_STATS_HOSTS (plano-escala F4-36): how
 * the process with the cron reaches PgBouncer's console, and what the env
 * check refuses. Apart from pgbouncer-metrics.ts, which logs, so the env
 * schema can read it without importing the logger (which reads the env).
 */

/** Tasks read at most: two in production (wave 23), four at the 5M. */
const PGBOUNCER_MAX_INSTANCES = 8;

/** The console's own database, which the SHOW commands list too. */
const CONSOLE_DATABASE = "pgbouncer";

interface PgBouncerStatsConfig {
  /** postgresql://pgbouncer_stats:<password>@<host>:6432/pgbouncer */
  url: string;

  /** Names whose addresses are read; empty reads the URL's host. */
  hosts: string[];
}

/** The stats login of PgBouncer's console, as the image creates it. */
const STATS_LOGIN = "pgbouncer_stats";

/**
 * Why PGBOUNCER_STATS_URL cannot be used, or null. The login must be the
 * stats one and the database the console: the admin login (PAUSE, KILL,
 * SHUTDOWN) never reaches the API's environment, nor a runtime login,
 * whose password has no business in a monitoring variable.
 */
function pgBouncerStatsUrlProblem(value: string): string | null {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return "precisa ser uma URL postgresql://";
  }

  if (!/^postgres(ql)?:$/.test(url.protocol)) {
    return "precisa ser uma URL postgresql://";
  }

  if (decodeURIComponent(url.username) !== STATS_LOGIN) {
    return (
      `usa só o login ${STATS_LOGIN}, o de estatística (só SHOW): o login de ` +
      "administração do PgBouncer (PAUSE, KILL, SHUTDOWN) fica só com o " +
      "dono, no console de dentro do contêiner, e nunca no Environment de " +
      "uma Application"
    );
  }

  if (url.pathname !== `/${CONSOLE_DATABASE}`) {
    return `aponta para o banco do console, /${CONSOLE_DATABASE}`;
  }

  return null;
}

/** A host name or an address, as PGBOUNCER_STATS_HOSTS lists them. */
const HOST_NAME = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,252})$/;

/** The names of PGBOUNCER_STATS_HOSTS: comma-separated, blanks dropped. */
function statsHosts(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter((host) => host !== "");
}

/** Why PGBOUNCER_STATS_HOSTS cannot be used, or null. */
function pgBouncerStatsHostsProblem(value: string): string | null {
  const hosts = statsHosts(value);

  const invalid = hosts.filter((host) => !HOST_NAME.test(host) && !isIP(host));

  if (invalid.length > 0) {
    return `nomes inválidos: ${invalid.join(", ")} (um nome ou endereço por item, separados por vírgula, como tasks.trajetto-pgbouncer-production)`;
  }

  if (hosts.length > PGBOUNCER_MAX_INSTANCES) {
    return `no máximo ${PGBOUNCER_MAX_INSTANCES} nomes`;
  }

  return null;
}

/** The configuration, or null when PGBOUNCER_STATS_URL is not set. */
function pgBouncerStatsConfig(env: {
  PGBOUNCER_STATS_URL?: string;
  PGBOUNCER_STATS_HOSTS?: string;
}): PgBouncerStatsConfig | null {
  const url = env.PGBOUNCER_STATS_URL?.trim();

  if (!url) return null;

  return { url, hosts: statsHosts(env.PGBOUNCER_STATS_HOSTS) };
}

export {
  CONSOLE_DATABASE,
  PGBOUNCER_MAX_INSTANCES,
  pgBouncerStatsConfig,
  pgBouncerStatsHostsProblem,
  pgBouncerStatsUrlProblem,
  statsHosts,
};
export type { PgBouncerStatsConfig };
