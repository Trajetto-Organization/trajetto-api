import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * The release step of the pipeline: the Dokploy Application
 * trajetto-api-migrate redeployed, and the run waiting for the step's
 * OUTCOME — not for Dokploy's `done`, which only means Swarm accepted the
 * spec. The release image's command migrates, seeds, writes a marker and
 * idles; its healthcheck waits for the marker, so Swarm reports the task
 * `Starting` while it migrates, `Running` once it finished and `Failed` when
 * a migration or a seed failed (docker-entrypoint.sh, mode `release`).
 *
 * The script runs for real here, against a fake Dokploy on the loopback with
 * the shapes Dokploy v0.30.10 answers: application.one (the Application, its
 * Environment included) and docker.getServiceContainersByAppName (the
 * output of `docker service ps --no-trunc`, newest task first, with the
 * desired state lowercased). The deploy itself is dokploy-deploy.mjs,
 * tested in dokploy-deploy.test.ts.
 */
const SCRIPT = resolve(
  process.cwd(),
  ".github",
  "scripts",
  "dokploy-release.mjs",
);
const KEY = "dokploy-key-that-must-never-be-printed";
const DATABASE_URL = "postgresql://owner:db-password-never-printed@db/trajetto";
const IMAGE = "ghcr.io/trajetto-organization/trajetto-api-migrate:staging";
const APP_NAME = "trajetto-api-migrate-x1y2z3";

interface Task {
  containerId: string;
  currentState: string;
  error?: string;
}

/** A row as Dokploy builds it from `docker service ps`. */
const row = (task: Task) => ({
  containerId: task.containerId,
  name: `${APP_NAME}.1`,
  state: task.currentState.startsWith("Running") ? "running" : "shutdown",
  currentState: task.currentState,
  node: "vps",
  error: task.error ?? "",
});

/** The release Application as the owner sets it up (docs/deploy.md). */
const APPLICATION = {
  applicationId: "mig_123",
  appName: APP_NAME,
  sourceType: "docker",
  dockerImage: IMAGE,
  env: `DATABASE_URL=${DATABASE_URL}`,
  applicationStatus: "done",
  replicas: 1,
  restartPolicySwarm: { Condition: "none" },
  healthCheckSwarm: null,
  modeSwarm: null,
  updateConfigSwarm: null,
};

interface Call {
  method: string;
  path: string;
  key: string | undefined;
}

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((done) =>
    server ? server.close(() => done()) : done(),
  );
  server = undefined;
});

/**
 * A Dokploy whose task list is `before` until the deploy call (or walks
 * through `beforeReads`, one read at a time), and then walks through
 * `after` one read at a time (the last one repeats). Its deployment list is
 * `history` until the deploy call, which adds a `done` deployment at once.
 */
async function fakeDokploy(options: {
  application?: Record<string, unknown>;
  before?: Task[];
  beforeReads?: Task[][];
  after?: Task[][];
  history?: Array<{ deploymentId: string; status: string }>;
  deployStatus?: number;
  /** The first N reads of the tasks after the deploy answer 503. */
  taskFailures?: number;
}) {
  const calls: Call[] = [];
  let deployed = false;
  let reads = 0;
  let readsBefore = 0;
  let taskFailures = options.taskFailures ?? 0;

  server = createServer((request: IncomingMessage, response) => {
    request.resume();
    request.on("end", () => {
      const path = request.url ?? "";

      calls.push({
        method: request.method ?? "",
        path,
        key: request.headers["x-api-key"] as string | undefined,
      });
      response.setHeader("content-type", "application/json");

      if (request.headers["x-api-key"] !== KEY) {
        response.statusCode = 401;
        response.end(JSON.stringify({ message: "Unauthorized" }));
        return;
      }

      if (path.startsWith("/api/application.one?")) {
        response.end(JSON.stringify(options.application ?? APPLICATION));
        return;
      }

      if (path.startsWith("/api/docker.getServiceContainersByAppName?")) {
        if (deployed && taskFailures > 0) {
          taskFailures -= 1;
          response.statusCode = 503;
          response.end(JSON.stringify({ message: "upstream unavailable" }));
          return;
        }

        const walk = options.after ?? [];
        const early = options.beforeReads;
        const tasks = deployed
          ? (walk[Math.min(reads++, walk.length - 1)] ?? [])
          : early
            ? (early[Math.min(readsBefore++, early.length - 1)] ?? [])
            : (options.before ?? []);

        response.end(JSON.stringify(tasks.map(row)));
        return;
      }

      if (path.startsWith("/api/application.deploy")) {
        response.statusCode = options.deployStatus ?? 200;
        deployed = response.statusCode === 200;
        response.end(deployed ? "true" : JSON.stringify({ message: "nope" }));
        return;
      }

      if (path.startsWith("/api/deployment.all?")) {
        const history = options.history ?? [];

        response.end(
          JSON.stringify(
            deployed
              ? [{ deploymentId: "release-1", status: "done" }, ...history]
              : history,
          ),
        );
        return;
      }

      response.statusCode = 404;
      response.end("{}");
    });
  });

  await new Promise<void>((done) =>
    server!.listen(0, "127.0.0.1", () => done()),
  );

  return {
    url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`,
    calls,
  };
}

function release(env: Record<string, string>) {
  return new Promise<{ status: number | null; output: string }>((done) => {
    const child = spawn(process.execPath, [SCRIPT], {
      // Not the test's own env: nothing of the developer's reaches the script.
      env: {
        PATH: process.env.PATH ?? "",
        ...(process.env.SystemRoot
          ? { SystemRoot: process.env.SystemRoot }
          : {}),
        DOKPLOY_POLL_SECONDS: "0.01",
        DOKPLOY_TIMEOUT_SECONDS: "2",
        DOKPLOY_RETRY_SECONDS: "0",
        RELEASE_POLL_SECONDS: "0.01",
        RELEASE_TIMEOUT_SECONDS: "2",
        ...env,
      },
    });

    let output = "";

    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", (status) => done({ status, output }));
  });
}

const valid = (fake: { url: string }) => ({
  DOKPLOY_URL: fake.url,
  DOKPLOY_API_KEY: KEY,
  DOKPLOY_APPLICATION_ID: "mig_123",
  RELEASE_IMAGE: IMAGE,
});

const routes = (calls: Call[]) => calls.map((call) => call.path.split("?")[0]);

const OLD_IDLE: Task = {
  containerId: "old",
  currentState: "Running 2 hours ago",
};

// As in dokploy-deploy.test.ts: every case starts Node processes, and a
// saturated machine must not turn their start-up into a failure.
describe("the release step on Dokploy", { timeout: 30_000 }, () => {
  it("succeeds once the task this deploy created reports the step done", async () => {
    const fake = await fakeDokploy({
      before: [OLD_IDLE],
      after: [
        [OLD_IDLE],
        [
          { containerId: "new", currentState: "Starting 2 seconds ago" },
          OLD_IDLE,
        ],
        [
          { containerId: "new", currentState: "Running 1 second ago" },
          { containerId: "old", currentState: "Shutdown 1 second ago" },
        ],
      ],
    });

    const result = await release(valid(fake));

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain(
      "Migrations: trajetto-api-migrate concluiu a etapa de release",
    );
    // Read the Application and its tasks BEFORE deploying, then follow.
    expect(routes(fake.calls).slice(0, 4)).toEqual([
      "/api/application.one",
      "/api/docker.getServiceContainersByAppName",
      "/api/deployment.all",
      "/api/application.deploy",
    ]);
    expect(fake.calls[1].path).toBe(
      `/api/docker.getServiceContainersByAppName?appName=${APP_NAME}`,
    );
    expect(fake.calls.every((call) => call.key === KEY)).toBe(true);
  });

  it("succeeds on the first deploy, when the service did not exist yet", async () => {
    const fake = await fakeDokploy({
      application: { ...APPLICATION, applicationStatus: "idle" },
      before: [],
      history: [],
      after: [
        [{ containerId: "first", currentState: "Preparing 1 second ago" }],
        [{ containerId: "first", currentState: "Running 1 second ago" }],
      ],
    });

    const result = await release(valid(fake));

    expect(result.status, result.output).toBe(0);
    // Three reads of the empty list, then the deployment history, before
    // anything is deployed.
    expect(routes(fake.calls).slice(0, 5)).toEqual([
      "/api/application.one",
      "/api/docker.getServiceContainersByAppName",
      "/api/docker.getServiceContainersByAppName",
      "/api/docker.getServiceContainersByAppName",
      "/api/deployment.all",
    ]);
  });

  it("goes ahead after a manual Deploy that failed before the tag existed (no service yet)", async () => {
    // A Deploy clicked before the pipeline moved the tag fails on the pull
    // and ends in `error`, creating no Swarm service.
    const fake = await fakeDokploy({
      application: { ...APPLICATION, applicationStatus: "error" },
      before: [],
      history: [{ deploymentId: "manual", status: "error" }],
      after: [[{ containerId: "first", currentState: "Running 1 second ago" }]],
    });

    const result = await release(valid(fake));

    expect(result.status, result.output).toBe(0);
  });

  it.each(["done", "idle"])(
    "refuses an empty task list for an Application deployed before (status %s), before deploying",
    async (applicationStatus) => {
      // Dokploy answers [] on any stderr from `docker service ps`. Believed,
      // the old idle task would look new after the deploy: a false success.
      // `idle` too: saving the Docker provider (a new GHCR token) sets it on
      // a live service.
      const fake = await fakeDokploy({
        application: { ...APPLICATION, applicationStatus },
        before: [],
        history: [{ deploymentId: "last-release", status: "done" }],
        after: [
          [
            { containerId: "new", currentState: "Starting 2 seconds ago" },
            OLD_IDLE,
          ],
        ],
      });

      const result = await release(valid(fake));

      expect(result.status).toBe(1);
      expect(result.output).toContain("devolveu a lista de tarefas");
      expect(result.output).toContain("Nada foi migrado.");
      expect(routes(fake.calls)).toEqual([
        "/api/application.one",
        "/api/docker.getServiceContainersByAppName",
        "/api/docker.getServiceContainersByAppName",
        "/api/docker.getServiceContainersByAppName",
        "/api/deployment.all",
      ]);
    },
  );

  it.each([10, 11])(
    "refuses an empty task list when the history is full (%i errors), since Dokploy keeps only the ten newest",
    async (errors) => {
      // Two release runs that failed on the pull (six attempts each) push
      // the last `done` out of the history while the service and its idle
      // task are still there.
      const fake = await fakeDokploy({
        application: { ...APPLICATION, applicationStatus: "idle" },
        before: [],
        history: Array.from({ length: errors }, (_, at) => ({
          deploymentId: `failed-${at}`,
          status: "error",
        })),
        after: [
          [
            { containerId: "new", currentState: "Starting 2 seconds ago" },
            OLD_IDLE,
          ],
        ],
      });

      const result = await release(valid(fake));

      expect(result.status).toBe(1);
      expect(result.output).toContain("guarda só os 10 mais recentes");
      expect(result.output).toContain("Nada foi migrado.");
      expect(routes(fake.calls)).not.toContain("/api/application.deploy");
    },
  );

  it("reads an empty list again, and keeps counting the old task out once it shows up", async () => {
    const fake = await fakeDokploy({
      beforeReads: [[], [OLD_IDLE]],
      history: [{ deploymentId: "last-release", status: "done" }],
      after: [
        [
          { containerId: "new", currentState: "Starting 2 seconds ago" },
          OLD_IDLE,
        ],
        [
          {
            containerId: "new",
            currentState: "Failed 1 second ago",
            error: '"task: non-zero exit (1)"',
          },
          OLD_IDLE,
        ],
      ],
    });

    const result = await release(valid(fake));

    // The old idle task was in the second read: the outcome is the new
    // task's failure, never the old task's Running.
    expect(result.status).toBe(1);
    expect(result.output).toContain("A etapa de release falhou");
  });

  it("takes a task that ran the step and exited 0 as done too", async () => {
    const fake = await fakeDokploy({
      before: [OLD_IDLE],
      after: [
        [
          { containerId: "new", currentState: "Complete 1 second ago" },
          OLD_IDLE,
        ],
      ],
    });

    const result = await release(valid(fake));

    expect(result.status, result.output).toBe(0);
  });

  it("fails with Swarm's reason when the step failed, even with the old idle task still Running", async () => {
    // Dokploy's default update config (start-first, rollback): a failed
    // release leaves the previous task Running. Only new tasks count.
    const fake = await fakeDokploy({
      before: [OLD_IDLE],
      after: [
        [
          { containerId: "new", currentState: "Starting 3 seconds ago" },
          OLD_IDLE,
        ],
        [
          {
            containerId: "new",
            currentState: "Failed 1 second ago",
            error: '"task: non-zero exit (1)"',
          },
          OLD_IDLE,
        ],
      ],
    });

    const result = await release(valid(fake));

    expect(result.status).toBe(1);
    expect(result.output).toContain(
      "::error::A etapa de release falhou em trajetto-api-migrate: Failed 1 second ago (task: non-zero exit (1)). A API não foi implantada",
    );
    expect(result.output).toContain("Application trajetto-api-migrate → Logs");
  });

  it.each(["Rejected 1 second ago", "Orphaned 1 second ago"])(
    "fails on a task %s",
    async (currentState) => {
      const fake = await fakeDokploy({
        before: [OLD_IDLE],
        after: [[{ containerId: "new", currentState }, OLD_IDLE]],
      });

      const result = await release(valid(fake));

      expect(result.status).toBe(1);
      expect(result.output).toContain("A etapa de release falhou");
    },
  );

  it("fails when the new task was stopped before it finished", async () => {
    const fake = await fakeDokploy({
      before: [OLD_IDLE],
      after: [
        [
          { containerId: "new", currentState: "Shutdown 1 second ago" },
          OLD_IDLE,
        ],
      ],
    });

    const result = await release(valid(fake));

    expect(result.status).toBe(1);
    expect(result.output).toContain("foi parada antes de terminar");
  });

  it("fails at the timeout while the step still runs, and says it was left running", async () => {
    const fake = await fakeDokploy({
      before: [OLD_IDLE],
      after: [
        [
          { containerId: "new", currentState: "Starting 9 minutes ago" },
          OLD_IDLE,
        ],
      ],
    });

    const result = await release({
      ...valid(fake),
      RELEASE_TIMEOUT_SECONDS: "0.2",
    });

    expect(result.status).toBe(1);
    expect(result.output).toContain("não terminou em 0.2s");
    expect(result.output).toContain(
      "uma migration nunca é interrompida no meio",
    );
  });

  it("fails at the timeout when no new task ever shows up", async () => {
    const fake = await fakeDokploy({ before: [OLD_IDLE], after: [[OLD_IDLE]] });

    const result = await release({
      ...valid(fake),
      RELEASE_TIMEOUT_SECONDS: "0.2",
    });

    expect(result.status).toBe(1);
    expect(result.output).toContain("nenhuma tarefa nova apareceu");
  });

  it("keeps waiting through a task list that failed to load", async () => {
    const fake = await fakeDokploy({
      before: [OLD_IDLE],
      taskFailures: 3,
      after: [[{ containerId: "new", currentState: "Running 1 second ago" }]],
    });

    const result = await release(valid(fake));

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("::warning::");
  });

  it("stops when Dokploy could not deploy, before waiting on any task", async () => {
    const fake = await fakeDokploy({ before: [OLD_IDLE], deployStatus: 400 });

    const result = await release(valid(fake));

    expect(result.status).toBe(1);
    expect(result.output).toContain(
      "O deploy de trajetto-api-migrate no Dokploy falhou",
    );
    expect(
      routes(fake.calls).filter(
        (route) => route === "/api/docker.getServiceContainersByAppName",
      ),
    ).toHaveLength(1);
  });

  it("never prints the API key, nor the Application's Environment", async () => {
    const fake = await fakeDokploy({
      before: [OLD_IDLE],
      after: [
        [
          {
            containerId: "new",
            currentState: "Failed 1 second ago",
            error: `"task: non-zero exit (1) ${KEY}"`,
          },
        ],
      ],
    });

    const result = await release(valid(fake));

    expect(result.status).toBe(1);
    expect(result.output).not.toContain(KEY);
    expect(result.output).not.toContain("db-password-never-printed");
  });

  it.each([
    [
      "Restart Policy unset (Swarm's `any`)",
      { restartPolicySwarm: null },
      'Restart Policy precisa ser {"Condition":"none"}',
    ],
    [
      "Restart Policy `any`",
      { restartPolicySwarm: { Condition: "any" } },
      'Restart Policy precisa ser {"Condition":"none"}',
    ],
    [
      "a Health Check of its own",
      { healthCheckSwarm: { Test: ["CMD", "true"] } },
      "Health Check precisa ficar vazio",
    ],
    ["two replicas", { replicas: 2 }, "exatamente 1 réplica"],
    ["global mode", { modeSwarm: { Global: {} } }, "exatamente 1 réplica"],
    [
      "stop-first updates",
      { updateConfigSwarm: { Parallelism: 1, Order: "stop-first" } },
      'Com "stop-first"',
    ],
    [
      "the API image",
      { dockerImage: "ghcr.io/trajetto-organization/trajetto-api:staging" },
      `precisa rodar a imagem ${IMAGE}`,
    ],
    [
      "production's tag",
      {
        dockerImage:
          "ghcr.io/trajetto-organization/trajetto-api-migrate:stable",
      },
      "DOKPLOY_MIGRATE_APPLICATION_ID é o da Application de migração deste ambiente",
    ],
    ["a git source", { sourceType: "github" }, "provider github"],
  ])(
    "refuses an Application with %s, before deploying anything",
    async (_case, change, message) => {
      const fake = await fakeDokploy({
        application: { ...APPLICATION, ...change },
      });

      const result = await release(valid(fake));

      expect(result.status).toBe(1);
      expect(result.output).toContain(message);
      expect(result.output).toContain("Nada foi migrado.");
      expect(routes(fake.calls)).toEqual(["/api/application.one"]);
    },
  );

  it("accepts the image name in any case, and the replicas through the Replicated mode", async () => {
    const fake = await fakeDokploy({
      application: {
        ...APPLICATION,
        dockerImage: IMAGE.toUpperCase(),
        replicas: 3,
        modeSwarm: { Replicated: { Replicas: 1 } },
        updateConfigSwarm: { Parallelism: 1, Order: "start-first" },
      },
      before: [OLD_IDLE],
      after: [[{ containerId: "new", currentState: "Running 1 second ago" }]],
    });

    const result = await release(valid(fake));

    expect(result.status, result.output).toBe(0);
  });

  it("refuses to start without the Application or the image it must run", async () => {
    const fake = await fakeDokploy({});

    for (const name of ["DOKPLOY_APPLICATION_ID", "RELEASE_IMAGE"]) {
      const result = await release({ ...valid(fake), [name]: "" });

      expect(result.status, name).toBe(1);
      expect(result.output).toContain(name);
    }

    expect(fake.calls).toEqual([]);
  });

  it("refuses plain http to anything but the loopback (the key goes in a header)", async () => {
    const result = await release({
      ...valid({ url: "http://dokploy.example.com" }),
    });

    expect(result.status).toBe(1);
    expect(result.output).toContain("precisa ser https://");
  });
});
