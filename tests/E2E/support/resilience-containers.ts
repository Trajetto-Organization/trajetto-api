import { execFileSync } from "node:child_process";

/**
 * Failure injection on the resilience package's OWN containers (contract §11
 * cases C and D): `trajetto-resil-pg` (Postgres, :54322) and
 * `trajetto-resil-redis` (Redis, :63791), created by
 * `tests/E2E/support/resilience-run.sh` from the same images as the shared
 * test containers.
 *
 * Every docker call goes through `control()`, which refuses any other name:
 * the shared trajetto-itest-pg / trajetto-test-redis serve every other
 * suite running on this machine, and the user's trajetto-database /
 * trajetto-redis hold real work. Stopping one of those from a test would be
 * an outage for somebody else.
 *
 * The cases that need this are skipped unless the run was started by that
 * script (RESILIENCE_DOCKER=1) AND the connections really point at those
 * ports — a stray env var alone does not arm it.
 */
const RESILIENCE_PG = "trajetto-resil-pg";
const RESILIENCE_REDIS = "trajetto-resil-redis";

const OWN_CONTAINERS = new Set([RESILIENCE_PG, RESILIENCE_REDIS]);

function portOf(url: string | undefined): string {
  if (!url) return "";

  try {
    return new URL(url).port;
  } catch {
    return "";
  }
}

function dockerFailureInjectionEnabled(): boolean {
  return (
    process.env.RESILIENCE_DOCKER === "1" &&
    portOf(process.env.DATABASE_URL) === "54322" &&
    portOf(process.env.REDIS_URL) === "63791"
  );
}

function control(action: "stop" | "start" | "kill", name: string): void {
  if (!OWN_CONTAINERS.has(name)) {
    throw new Error(
      `recusado: ${name} não é um container do pacote de resiliência`,
    );
  }

  // `stop -t 2`: SIGINT (Postgres' fast shutdown, every session terminated),
  // then SIGKILL after two seconds — the database going away under load.
  const args = action === "stop" ? ["stop", "-t", "2", name] : [action, name];

  execFileSync("docker", args, { stdio: "pipe", timeout: 60_000 });
}

async function waitFor(
  check: () => boolean,
  what: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!check()) {
    if (Date.now() > deadline)
      throw new Error(`tempo esgotado esperando ${what}`);

    await new Promise((done) => setTimeout(done, 250));
  }
}

function succeeds(args: string[]): boolean {
  try {
    execFileSync("docker", args, { stdio: "pipe", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

async function stopPostgres(): Promise<void> {
  control("stop", RESILIENCE_PG);
}

async function startPostgres(): Promise<void> {
  control("start", RESILIENCE_PG);

  // pg_isready over TCP: the socket inside the container answers before the
  // published port does.
  await waitFor(
    () =>
      succeeds([
        "exec",
        RESILIENCE_PG,
        "pg_isready",
        "-h",
        "127.0.0.1",
        "-p",
        "5432",
      ]),
    "o Postgres de resiliência voltar",
  );
}

async function stopRedis(): Promise<void> {
  control("stop", RESILIENCE_REDIS);
}

async function startRedis(): Promise<void> {
  control("start", RESILIENCE_REDIS);

  await waitFor(
    () => succeeds(["exec", RESILIENCE_REDIS, "redis-cli", "ping"]),
    "o Redis de resiliência voltar",
  );
}

export {
  RESILIENCE_PG,
  RESILIENCE_REDIS,
  dockerFailureInjectionEnabled,
  startPostgres,
  startRedis,
  stopPostgres,
  stopRedis,
};
