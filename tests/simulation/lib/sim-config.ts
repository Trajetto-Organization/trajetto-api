import { rmSync } from "node:fs";
import { resolve } from "node:path";

import { disposableDatabaseRefusal } from "../../load/lib/disposable-database";

/**
 * Where the delivery-day simulation runs, in one place: the dedicated
 * database on the shared test container, the replicas' ports and the
 * gitignored folder every generated file goes to.
 *
 * Nothing here points at a developer's database or at the ports the dev API
 * (3333) and the dev web (3001) use.
 */

/** The only database name the simulation writes to. */
const SIM_DATABASE_NAME = "trajetto_sim";

const DEFAULT_DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:54321/${SIM_DATABASE_NAME}?schema=public`;

/**
 * Database 9 of the shared test Redis: the rate-limit counters and one-use
 * tickets of the simulated replicas stay apart from the E2E suites' keys.
 * Pub/Sub ignores the database number, so the Socket.IO channels are kept
 * apart by SOCKET_ADAPTER_KEY instead (see sim-env.ts).
 */
const DEFAULT_REDIS_URL = "redis://127.0.0.1:63790/9";

/** Replica A first: the dispatcher and the web socket use it. */
const DEFAULT_REPLICA_PORTS = [3341, 3342];

/** Never these: the developer's own API and web. */
const FORBIDDEN_PORTS = new Set([3333, 3001]);

const SIMULATION_ROOT = resolve(__dirname, "..");
const API_ROOT = resolve(SIMULATION_ROOT, "..", "..");

/** Gitignored (see .gitignore): logs, the env file, the recorder's video. */
function workDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.SIM_WORK_DIR || resolve(SIMULATION_ROOT, "output"));
}

/**
 * What a run hands the recorder (trajetto-ui/tests/simulation): the
 * dispatcher's throwaway login, the routes, the log. A run that finishes
 * stamps `finishedAt` on it.
 */
const CONTEXT_FILE = "sim-context.json";

/**
 * Called when the database is recreated: the context of the previous run
 * describes a company that no longer exists. Left behind by a run that died
 * mid-day (no `finishedAt`), it would send a recorder started before the next
 * run — as the README orders — to film a dead day with a login that fails.
 * The logs stay: they are the evidence of past runs.
 */
function forgetPreviousRun(env: NodeJS.ProcessEnv = process.env): void {
  rmSync(resolve(workDirectory(env), CONTEXT_FILE), { force: true });
}

function simDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.SIM_DATABASE_URL || DEFAULT_DATABASE_URL;
}

/**
 * Null when the URL is the simulation's own database on the disposable
 * container; otherwise why not, in pt-BR. Stricter than the load harness
 * check it reuses: the database name must be the dedicated one too, so the
 * per-file E2E databases and the container's `trajetto` are never touched.
 */
function simDatabaseRefusal(
  url: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const refusal = disposableDatabaseRefusal(url, env);

  if (refusal) return refusal;

  const name = new URL(url as string).pathname.replace(/^\//, "");

  if (name !== SIM_DATABASE_NAME) {
    return `A simulação só usa o banco ${SIM_DATABASE_NAME}; a URL aponta para "${name}".`;
  }

  return null;
}

function assertSimDatabase(
  url: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const refusal = simDatabaseRefusal(url, env);

  if (refusal) throw new Error(refusal);
}

function replicaPorts(env: NodeJS.ProcessEnv = process.env): number[] {
  const raw = env.SIM_REPLICA_PORTS;
  const count = Number(env.SIM_REPLICAS ?? DEFAULT_REPLICA_PORTS.length);

  const ports = raw
    ? raw
        .split(",")
        .map((part) => Number(part.trim()))
        .filter((port) => Number.isInteger(port) && port > 0)
    : DEFAULT_REPLICA_PORTS.slice(0, Math.max(1, count));

  for (const port of ports) {
    if (FORBIDDEN_PORTS.has(port)) {
      throw new Error(
        `A porta ${port} é da API ou da web de desenvolvimento; use 3341/3342.`,
      );
    }
  }

  if (ports.length === 0) throw new Error("Nenhuma porta de réplica válida.");

  return ports;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * One SIM_API_URLS entry, checked like the ports the replicas are started
 * on: this machine only, never the dev API's or the dev web's port.
 */
function checkedApiUrl(url: string): string {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`SIM_API_URLS: "${url}" não é uma URL.`);
  }

  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    !LOOPBACK_HOSTS.has(parsed.hostname)
  ) {
    throw new Error(
      `SIM_API_URLS: ${url} não é uma réplica desta máquina; use http://127.0.0.1:3341 (start-replicas.ts).`,
    );
  }

  if (FORBIDDEN_PORTS.has(Number(parsed.port))) {
    throw new Error(
      `SIM_API_URLS: a porta ${parsed.port} é da API ou da web de desenvolvimento; use 3341/3342.`,
    );
  }

  return url;
}

/** SIM_API_URLS, or one URL per default replica port. */
function apiUrls(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.SIM_API_URLS;

  if (raw) {
    return raw
      .split(",")
      .map((url) => url.trim().replace(/\/+$/, ""))
      .filter(Boolean)
      .map(checkedApiUrl);
  }

  return replicaPorts(env).map((port) => `http://127.0.0.1:${port}`);
}

export {
  API_ROOT,
  CONTEXT_FILE,
  DEFAULT_DATABASE_URL,
  DEFAULT_REDIS_URL,
  FORBIDDEN_PORTS,
  SIMULATION_ROOT,
  SIM_DATABASE_NAME,
  apiUrls,
  assertSimDatabase,
  forgetPreviousRun,
  replicaPorts,
  simDatabaseRefusal,
  simDatabaseUrl,
  workDirectory,
};
