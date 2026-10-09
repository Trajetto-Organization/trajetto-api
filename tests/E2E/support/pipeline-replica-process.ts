import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";

/**
 * Starts `pipeline-replica.ts` as a process of its own — one API replica
 * running the workers — and kills it the two ways production does: a
 * graceful stop (SIGTERM path, the deploy) or a SIGKILL (the OOM killer, a
 * lost node, `docker kill`), which runs no `finally` and writes nothing.
 */
interface PipelineReplica {
  pid: number;
  process: ChildProcessWithoutNullStreams;

  /** Everything the replica logged, for a failure message. */
  output: () => string;

  /** The crash: no shutdown hook, no lease given back. */
  kill: () => Promise<void>;

  /** The deploy: drains what is in flight, then exits. */
  stop: () => Promise<void>;

  exited: Promise<number | null>;
}

interface ReplicaOptions {
  fakeProviderUrl: string;
  workers: Array<"notifications" | "webhooks" | "ai">;
  httpPort?: number;
  env?: Record<string, string>;
}

async function startPipelineReplica(options: ReplicaOptions): Promise<PipelineReplica> {
  // node + tsx's own entry: on Windows `npx` is a .cmd, and spawning one
  // without a shell fails with EINVAL since Node 20.
  const child = spawn(
    process.execPath,
    [
      resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"),
      "tests/E2E/support/pipeline-replica.ts",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        FAKE_PROVIDER_URL: options.fakeProviderUrl,
        REPLICA_WORKERS: options.workers.join(","),
        REPLICA_HTTP_PORT: String(options.httpPort ?? 0),

        // The minimum the env schema accepts: a test cannot wait 30 s sweeps.
        PIPELINE_SWEEP_INTERVAL_MS: "500",
        WORKERS_ENABLED: "true",

        // WhatsApp "configured", so the real Meta client runs (its fetch is
        // rewritten to the fake inside the replica).
        META_WHATSAPP_ACCESS_TOKEN: "fake-meta-token-for-resilience-tests",
        META_WHATSAPP_PHONE_NUMBER_ID: "100000000000001",
        AI_PROVIDER: "local",
        AI_LOCAL_URL: options.fakeProviderUrl,
        AI_LOCAL_TOKEN: "t".repeat(40),
        LOG_LEVEL: process.env.REPLICA_LOG_LEVEL ?? "warn",
        ...options.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  ) as ChildProcessWithoutNullStreams;

  let log = "";
  let ready = false;

  const exited = new Promise<number | null>((done) => child.once("exit", (code) => done(code)));

  child.stdout.on("data", (chunk) => {
    const text = String(chunk);

    log += text;
    if (text.includes("READY")) ready = true;
    if (log.length > 200_000) log = log.slice(-100_000);
  });

  child.stderr.on("data", (chunk) => {
    log += String(chunk);
    if (log.length > 200_000) log = log.slice(-100_000);
  });

  const deadline = Date.now() + 180_000;
  let gone = false;

  void exited.then(() => (gone = true));

  while (!ready) {
    if (gone || Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`a réplica não subiu: ${log.slice(-2_000)}`);
    }

    await new Promise((done) => setTimeout(done, 100));
  }

  return {
    pid: child.pid ?? 0,
    process: child,
    output: () => log,
    kill: async () => {
      if (gone) return;

      child.kill("SIGKILL");
      await exited;
    },
    stop: async () => {
      if (gone) return;

      child.stdin.write("stop\n");

      const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);

      await exited;
      clearTimeout(timer);
    },
    exited,
  };
}

export { startPipelineReplica };
export type { PipelineReplica, ReplicaOptions };
