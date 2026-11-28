import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import "../lib/no-env-file.cjs";

import { tsxArgs } from "../lib/guarded-node";
import {
  API_ROOT,
  assertSimDatabase,
  replicaPorts,
  workDirectory,
} from "../lib/sim-config";
import { writeSimEnvFile } from "../lib/sim-env";
import { killTree, PID_FILE } from "./stop-replicas";

/**
 * Starts N API replicas of the working tree with tsx, as real processes:
 *
 *   npx tsx tests/simulation/scripts/start-replicas.ts
 *
 * Ports 3341 and 3342 by default (SIM_REPLICAS=1 starts only 3341;
 * SIM_REPLICA_PORTS=3341,3342,3343 picks them). They share the test
 * container's Postgres (database trajetto_sim) and Redis, and each one runs
 * its own workers, cron and leases — exactly what two replicas behind
 * Traefik do. Their env file is generated in the work folder from the keys
 * of .env.example (sim-env.ts); the developer's .env is never read, by this
 * script or by the replicas (lib/no-env-file.cjs is preloaded in each).
 *
 * Stays in the foreground until Ctrl+C (or SIGTERM), then stops every
 * replica it started — the whole process tree, since tsx runs the server in
 * a child of its own. The PIDs also go to <work folder>/replicas.pids, so
 * `stop-replicas.ts` can stop them if this terminal was closed. Each
 * replica's output goes to <work folder>/replica-<port>.log.
 */
const READY_TIMEOUT_MS = 180_000;

const children: ChildProcess[] = [];
let stopping = false;

function stopAll(code = 0): void {
  if (stopping) return;
  stopping = true;

  console.log("\n[sim] Parando as réplicas…");

  for (const child of children) {
    if (child.pid && child.exitCode === null) killTree(child.pid);
  }

  try {
    rmSync(resolve(workDirectory(), PID_FILE), { force: true });
  } catch {
    // Best effort: stop-replicas.ts tolerates a stale file.
  }

  setTimeout(() => process.exit(code), 1_500).unref();
}

async function waitUntilReady(
  port: number,
  child: ChildProcess,
): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `A réplica ${port} terminou com ${child.exitCode} antes de ficar pronta (veja replica-${port}.log).`,
      );
    }

    try {
      const response = await fetch(`http://127.0.0.1:${port}/health/liveness`);

      if (response.ok) return;
    } catch {
      // Not listening yet.
    }

    await new Promise((done) => setTimeout(done, 500));
  }

  throw new Error(
    `A réplica ${port} não ficou pronta em ${READY_TIMEOUT_MS / 1000} s.`,
  );
}

async function main(): Promise<void> {
  const ports = replicaPorts();
  const work = workDirectory();
  const envFile = resolve(work, "replicas.env");

  mkdirSync(work, { recursive: true });

  const values = writeSimEnvFile(envFile, {
    apiUrl: `http://localhost:${ports[0]}`,
    webUrl: process.env.SIM_WEB_URL || "http://localhost:3100",
  });

  assertSimDatabase(values.DATABASE_URL);

  console.log(`[sim] Env das réplicas: ${envFile}`);

  process.on("SIGINT", () => stopAll());
  process.on("SIGTERM", () => stopAll());

  for (const port of ports) {
    const log = createWriteStream(resolve(work, `replica-${port}.log`), {
      flags: "a",
    });

    // The working directory is the API's, where its templates and
    // package.json are read from — and where the developer's .env sits, which
    // the guard in tsxArgs keeps unread (dotenv-expand would otherwise fill
    // every key left empty above with the file's value).
    const child = spawn(process.execPath, tsxArgs("src/server.ts"), {
      cwd: API_ROOT,
      env: { ...process.env, ...values, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.pipe(log);
    child.stderr?.pipe(log);

    child.on("exit", (code) => {
      console.log(`[sim] Réplica ${port} saiu (código ${code ?? "sinal"}).`);

      if (!stopping) stopAll(1);
    });

    children.push(child);
    console.log(`[sim] Réplica ${port}: pid ${child.pid}`);
  }

  writeFileSync(
    resolve(work, PID_FILE),
    `${children.map((child) => child.pid).join("\n")}\n`,
  );

  await Promise.all(
    ports.map((port, index) => waitUntilReady(port, children[index])),
  );

  console.log(
    `[sim] Prontas: ${ports.map((port) => `http://127.0.0.1:${port}`).join(", ")}. Ctrl+C para parar.`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  stopAll(1);
});
