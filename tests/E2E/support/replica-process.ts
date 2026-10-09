import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";

/**
 * Starts `socket-replica.ts` as a process of its own — one API replica.
 *
 * `io` and the adapter clients are module singletons, so a second node has to
 * be a second process. Same launcher as `multi-replica-events.test.ts`, with
 * the environment open to overrides: a replica pointed at a dead Redis, or
 * one that sweeps its sessions every second.
 */
interface ReplicaCommand {
  kind: "routeEvent" | "driverPosition" | "securityToBusiness" | "securityToUser";
  businessId: string;
  payload: Record<string, unknown>;
}

interface Replica {
  process: ChildProcessWithoutNullStreams;
  port: number;

  /** Resolves once the replica reports the command ran. */
  run: (command: ReplicaCommand) => Promise<void>;

  stop: () => Promise<void>;
}

/** A port the OS just said is free, which beats guessing one. */
function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();

    probe.once("error", fail);

    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => done(port));
    });
  });
}

async function startReplica(env: Record<string, string>): Promise<Replica> {
  const port = await freePort();

  // node + tsx's own entry: on Windows `npx` is a .cmd, and spawning one
  // without a shell fails with EINVAL since Node 20.
  const child = spawn(
    process.execPath,
    [
      resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"),
      "tests/E2E/support/socket-replica.ts",
      String(port),
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, PORT: String(port), ...env },
      stdio: ["pipe", "pipe", "pipe"],
    },
  ) as ChildProcessWithoutNullStreams;

  const lines: string[] = [];
  let failure = "";

  child.stdout.on("data", (chunk) => {
    for (const line of String(chunk).split("\n")) {
      if (line.trim()) lines.push(line.trim());
    }
  });

  // Kept so a replica that dies during boot says why.
  child.stderr.on("data", (chunk) => {
    failure += String(chunk);
  });

  const waitForLine = (matches: (line: string) => boolean, timeoutMs: number) =>
    new Promise<void>((done, fail) => {
      const deadline = Date.now() + timeoutMs;

      const poll = setInterval(() => {
        const index = lines.findIndex(matches);

        if (index >= 0) {
          lines.splice(index, 1);
          clearInterval(poll);
          done();
          return;
        }

        if (Date.now() > deadline) {
          clearInterval(poll);
          fail(
            new Error(
              `a réplica na porta ${port} não respondeu a tempo. ${failure.slice(-1200)}`,
            ),
          );
        }
      }, 50);
    });

  await waitForLine((line) => line.startsWith("READY"), 180_000);

  return {
    process: child,
    port,
    run: async (command) => {
      child.stdin.write(`${JSON.stringify(command)}\n`);

      await waitForLine((line) => line === `SENT ${command.kind}`, 15_000);
    },
    stop: async () => {
      child.stdin.end();

      await new Promise((done) => setTimeout(done, 1_500));

      if (!child.killed) child.kill();
    },
  };
}

export { freePort, startReplica };
export type { Replica, ReplicaCommand };
