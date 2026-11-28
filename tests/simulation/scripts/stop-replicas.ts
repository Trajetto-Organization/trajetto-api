import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import { workDirectory } from "../lib/sim-config";

/**
 * Stops the replicas `start-replicas.ts` started, from their PID file:
 *
 *   npx tsx tests/simulation/scripts/stop-replicas.ts
 *
 * For when the terminal that started them was closed. Only the PIDs written
 * by start-replicas are touched, each with its whole tree (tsx runs the
 * server in a child process of its own).
 */
const PID_FILE = "replicas.pids";

/** The process and every child of it. */
function killTree(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
    });
    return;
  }

  try {
    // Negative pid: the process group, when the child leads one.
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
}

function main(): void {
  const file = resolve(workDirectory(), PID_FILE);

  if (!existsSync(file)) {
    console.log(`[sim] Nenhuma réplica registrada em ${file}.`);
    return;
  }

  const pids = readFileSync(file, "utf8")
    .split(/\s+/)
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0);

  for (const pid of pids) killTree(pid);

  rmSync(file, { force: true });
  console.log(`[sim] Paradas: ${pids.join(", ") || "nenhuma"}.`);
}

if (require.main === module) main();

export { killTree, PID_FILE };
