import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runBlock } from "./support/run-block";
import {
  hasShell,
  repoFile,
  run,
  sandbox,
  type Sandbox,
} from "./support/shell-harness";
import {
  actionOf,
  conditionOf,
  jobOf,
  readAction,
  readWorkflow,
  stepNames,
  stepOf,
  workflowOf,
  type Action,
  type Workflow,
} from "./support/workflow-text";

/**
 * The deploy step proves the deployment CONVERGED, not that Dokploy was asked.
 *
 * Dokploy's deployment of an Application is `done` once the manager accepted
 * the new service spec. The rollout happens afterwards: an image that fails
 * its healthcheck is rolled back by Swarm on its own (failure_action:
 * rollback), the old build keeps serving, and the promote finished green
 * anyway — the false green the Dokploy script was said to remove. Now each
 * deploy waits for the running state:
 *
 *   - API: infra/scripts/verify-rollout.sh on the manager (SSH forced
 *     command), reading the service spec, its UpdateStatus and its tasks;
 *   - web: trajetto-ui/.github/scripts/wait-for-build.mjs, reading
 *     /build-id.json through the real edge.
 *
 * Both run for real here: the first against a docker stub that walks through
 * a rollout one inspect at a time, the second against a fake site.
 */
const ROOT = process.cwd();
const WEB = resolve(ROOT, "..", "trajetto-ui");

const read = (...path: string[]) =>
  readFileSync(resolve(...path), "utf8").replace(/\r\n/g, "\n");

const sh = hasShell("sh");

const REPO = "ghcr.io/trajetto-organization/trajetto-api";
const NEW = `sha256:${"a".repeat(64)}`;
const OLD = `sha256:${"b".repeat(64)}`;
const IMAGE = `${REPO}@${NEW}`;
/** The service name a Dokploy Application gets: its appName. */
const SERVICE = "trajetto-api-x1y2z3";
/** A spec the Docker CLI pinned when it resolved the tag. */
const spec = (digest: string) => `${REPO}:stable@${digest}`;
/** The spec a Dokploy Application writes: the bare tag, no digest. */
const TAG_SPEC = `${REPO}:stable`;

let taskIds = 0;

/** A task of a pinned spec: its image names the digest. */
const task = (digest: string, state = "Running 5 seconds ago") =>
  `t${++taskIds}|${spec(digest)}|${state}`;

/**
 * A task of a bare-tag spec: `docker service ps` shows only the tag, and the
 * digest comes from the image its container was created from. `pulled` null:
 * no container this node can read (another node, or not created yet).
 */
function tagTask(
  pulled: string | null,
  state = "Running 5 seconds ago",
): { line: string; id: string; pulled: string | null } {
  const id = `t${++taskIds}`;

  return { line: `${id}|${TAG_SPEC}|${state}`, id, pulled };
}

/**
 * `docker service inspect --format` and `docker service ps` answer step N of
 * the rollout on their Nth call (the last step repeats): the script calls
 * each once per poll. A task's container is `c-<task>`, its image `i-<task>`,
 * and that image's RepoDigests are the file `image.<task>` (absent: the
 * container is not on this node). The read of the stop grace and of
 * STOP_GRACE_PERIOD_MS answers the file `grace` (absent: no grace set and no
 * variable, `null|`).
 */
const DOCKER = `
step() {
  n=$(cat "$STUB_DIR/$1.n" 2>/dev/null || echo 1)
  cat "$STUB_DIR/$1.$n"
  if [ -f "$STUB_DIR/$1.$((n + 1))" ]; then echo $((n + 1)) > "$STUB_DIR/$1.n"; fi
}
last() { for arg in "$@"; do :; done; printf '%s' "$arg"; }
case "$1 $2" in
  "service inspect")
    case "$*" in
      *StopGracePeriod*)
        if [ -f "$STUB_DIR/grace" ]; then cat "$STUB_DIR/grace"; else echo "null|"; fi ;;
      *--format*) step inspect ;;
      *) [ -f "$STUB_DIR/missing" ] && exit 1; echo "[]" ;;
    esac ;;
  "service ps") step ps ;;
  "container inspect")
    id=$(last "$@"); id=\${id#c-}
    [ -f "$STUB_DIR/image.$id" ] || exit 1
    echo "i-$id" ;;
  "image inspect")
    id=$(last "$@"); id=\${id#i-}
    cat "$STUB_DIR/image.$id" ;;
  *)
    case "$1" in
      inspect) echo "c-$(last "$@")" ;;
    esac ;;
esac
exit 0`;

interface Step {
  /** `<spec image>|<UpdateStatus.State>|<replicas>` */
  inspect: string;
  tasks: Array<string | ReturnType<typeof tagTask>>;
}

describe.skipIf(!sh)("the API rollout check (verify-rollout.sh)", () => {
  let box: Sandbox;

  beforeEach(() => {
    box = sandbox();
    box.stub("docker", DOCKER);
  });

  afterEach(() => box.dispose());

  function rollout(
    steps: Step[],
    args: string[] = [SERVICE, IMAGE],
    env: Record<string, string> = {},
  ) {
    steps.forEach((each, index) => {
      writeFileSync(`${box.root}/inspect.${index + 1}`, `${each.inspect}\n`);
      writeFileSync(
        `${box.root}/ps.${index + 1}`,
        each.tasks
          .map((entry) => `${typeof entry === "string" ? entry : entry.line}\n`)
          .join(""),
      );

      for (const entry of each.tasks) {
        if (typeof entry !== "string" && entry.pulled !== null) {
          writeFileSync(`${box.root}/image.${entry.id}`, `${entry.pulled}\n`);
        }
      }
    });

    return run("sh", repoFile("infra/scripts/verify-rollout.sh"), args, {
      bin: box.bin,
      env: {
        STUB_DIR: box.root,
        ROLLOUT_POLL_SECONDS: "0",
        ROLLOUT_TIMEOUT_SECONDS: "20",
        ...env,
      },
    });
  }

  // One per poll: the spec, its update state and replicas in one inspect.
  // The stop grace is read apart, once the rollout converged.
  const inspections = () =>
    box
      .calls("docker")
      .filter(
        (call) =>
          call.startsWith("docker service inspect") &&
          call.includes("--format") &&
          !call.includes("StopGracePeriod"),
      ).length;

  it("waits through the update and succeeds once every replica runs the digest", () => {
    const result = rollout([
      // The spec just changed; the updater has not started yet.
      { inspect: `${spec(NEW)}||2`, tasks: [task(OLD), task(OLD)] },
      // start-first: the new task beside the old ones.
      {
        inspect: `${spec(NEW)}|updating|2`,
        tasks: [task(NEW, "Starting 1 second ago"), task(OLD), task(OLD)],
      },
      // Every task replaced, but Swarm is still inside the monitor window.
      { inspect: `${spec(NEW)}|updating|2`, tasks: [task(NEW), task(NEW)] },
      { inspect: `${spec(NEW)}|completed|2`, tasks: [task(NEW), task(NEW)] },
    ]);

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain(
      `ok: ${SERVICE} roda ${NEW} em 2 réplica(s)`,
    );
    // Not declared converged while the update was still being monitored.
    expect(inspections()).toBe(4);
  });

  it("fails when Swarm rolls the update back", () => {
    const result = rollout([
      {
        inspect: `${spec(NEW)}|updating|2`,
        tasks: [task(NEW, "Starting 1 second ago"), task(OLD), task(OLD)],
      },
      {
        inspect: `${spec(OLD)}|rollback_started|2`,
        tasks: [task(OLD), task(OLD)],
      },
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/rollback_started.*reverteu/);
  });

  it("fails when the rollback already finished on the previous digest", () => {
    const result = rollout([
      {
        inspect: `${spec(OLD)}|rollback_completed|2`,
        tasks: [task(OLD), task(OLD)],
      },
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`reverteu ${SERVICE} para ${spec(OLD)}`);
  });

  it("accepts a rollback state an earlier deploy left, when the digest asked for is what runs", () => {
    // Promoting the build already running (the rollback button): the spec
    // does not change, so Swarm keeps the old UpdateStatus.
    const result = rollout([
      {
        inspect: `${spec(NEW)}|rollback_completed|2`,
        tasks: [task(NEW), task(NEW)],
      },
    ]);

    expect(result.status, result.stderr).toBe(0);
  });

  it("keeps waiting while a task of the old image is still meant to run", () => {
    const result = rollout([
      {
        inspect: `${spec(NEW)}|completed|2`,
        tasks: [task(NEW), task(NEW), task(OLD)],
      },
      { inspect: `${spec(NEW)}|completed|2`, tasks: [task(NEW), task(NEW)] },
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(inspections()).toBe(2);
  });

  describe("a Dokploy Application's spec (a bare tag, no digest)", () => {
    // Dokploy updates the service through the Engine API, which never
    // resolves a tag: the spec says `:stable` and nothing about the build.
    // Which build runs is read from each task's container instead.
    const pulled = (digest: string) => `${REPO}@${digest}`;

    it("succeeds once every task's container runs an image pulled as the digest", () => {
      const result = rollout([
        {
          inspect: `${TAG_SPEC}|updating|2`,
          tasks: [
            tagTask(pulled(NEW), "Starting 1 second ago"),
            tagTask(pulled(OLD)),
            tagTask(pulled(OLD)),
          ],
        },
        {
          inspect: `${TAG_SPEC}|completed|2`,
          tasks: [tagTask(pulled(NEW)), tagTask(pulled(NEW))],
        },
      ]);

      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain(
        `ok: ${SERVICE} roda ${NEW} em 2 réplica(s)`,
      );
      expect(inspections()).toBe(2);
    });

    it("never counts a digest of another repository that happens to match", () => {
      const result = rollout(
        [
          {
            inspect: `${TAG_SPEC}|completed|1`,
            tasks: [
              tagTask(`ghcr.io/trajetto-organization/trajetto-ui@${NEW}`),
            ],
          },
        ],
        undefined,
        { ROLLOUT_TIMEOUT_SECONDS: "0" },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("não convergiu");
    });

    it("fails when Swarm rolled back and every task runs the previous build", () => {
      const result = rollout([
        {
          inspect: `${TAG_SPEC}|rollback_completed|2`,
          tasks: [tagTask(pulled(OLD)), tagTask(pulled(OLD))],
        },
      ]);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`reverteu ${SERVICE}`);
      expect(inspections()).toBe(1);
    });

    it("accepts an earlier rollback state when the digest asked for is what runs", () => {
      const result = rollout([
        {
          inspect: `${TAG_SPEC}|rollback_completed|2`,
          tasks: [tagTask(pulled(NEW)), tagTask(pulled(NEW))],
        },
      ]);

      expect(result.status, result.stderr).toBe(0);
    });

    it("says so at the deadline when a task's container is not on this node", () => {
      const result = rollout(
        [
          {
            inspect: `${TAG_SPEC}|completed|2`,
            tasks: [tagTask(pulled(NEW)), tagTask(null)],
          },
        ],
        undefined,
        { ROLLOUT_TIMEOUT_SECONDS: "0" },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(
        /1 task\(s\) sem container legível neste nó/,
      );
    });

    it("fails at once when the service runs another image altogether", () => {
      // SWARM_API_SERVICE pointing at the web's or the AI's Application.
      const result = rollout([
        {
          inspect:
            "ghcr.io/trajetto-organization/trajetto-ui:stable|completed|1",
          tasks: [tagTask(pulled(NEW))],
        },
      ]);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("não é o deste deploy");
      expect(inspections()).toBe(1);
    });
  });

  /**
   * The API derives every shutdown deadline from STOP_GRACE_PERIOD_MS
   * (plano-escala F1-14). Set above the Stop Grace Period the service really
   * has, every deploy SIGKILLs the old replicas halfway through their
   * shutdown, and nothing says so: the rollout converges all the same. So
   * the check reads both from the spec once the rollout converged
   * (plano-escala F1-16): the grace, absent meaning Docker's 10 s, and the
   * variable, absent meaning the API's own 10 000.
   */
  describe("the stop grace against STOP_GRACE_PERIOD_MS", () => {
    const converged: Step[] = [
      { inspect: `${spec(NEW)}|completed|2`, tasks: [task(NEW), task(NEW)] },
    ];

    it("passes with neither set: Docker's 10 s and the API's 10 s default", () => {
      const result = rollout(converged);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(
        "grace: 10000 ms (o padrão do Docker) cobre STOP_GRACE_PERIOD_MS=10000",
      );
    });

    it("passes when the service's grace covers the variable", () => {
      writeFileSync(
        `${box.root}/grace`,
        "40000000000|STOP_GRACE_PERIOD_MS=40000\n",
      );

      const result = rollout(converged);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(
        "grace: 40000 ms (o Stop Grace Period do serviço) cobre STOP_GRACE_PERIOD_MS=40000",
      );
    });

    it("fails, saying what to change, when the variable passes Docker's default grace", () => {
      // The variable typed before the service got its 40 s.
      writeFileSync(`${box.root}/grace`, "null|STOP_GRACE_PERIOD_MS=40000\n");

      const result = rollout(converged);

      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain("ok:");
      expect(result.stderr).toContain(
        `STOP_GRACE_PERIOD_MS=40000 passa de 10000 ms, o padrão do Docker`,
      );
      expect(result.stderr).toContain("Stop Grace Period");
    });

    it("counts the grace in whole seconds, as the daemon does", () => {
      // 40.5 s reaches the container as a 40 s stop timeout.
      writeFileSync(
        `${box.root}/grace`,
        "40500000000|STOP_GRACE_PERIOD_MS=40500\n",
      );

      const result = rollout(converged);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("passa de 40000 ms");
    });

    it("reads the last of a repeated variable, as the container does", () => {
      writeFileSync(
        `${box.root}/grace`,
        "40000000000|STOP_GRACE_PERIOD_MS=90000\nSTOP_GRACE_PERIOD_MS=40000\n",
      );

      expect(rollout(converged).status).toBe(0);
    });

    it("fails on a variable that is not a whole number, without printing it", () => {
      writeFileSync(
        `${box.root}/grace`,
        "40000000000|STOP_GRACE_PERIOD_MS=40s\n",
      );

      const result = rollout(converged);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("não é um número inteiro");
      expect(result.stderr).not.toContain("40s");
    });

    it("asks docker for that one variable, never the whole Environment", () => {
      rollout(converged);

      const read = box
        .calls("docker")
        .find((call) => call.includes("StopGracePeriod"));

      expect(read).toBeDefined();
      expect(read).toContain('"STOP_GRACE_PERIOD_MS"');
      expect(read).not.toMatch(
        /\{\{json \.Spec\.TaskTemplate\.ContainerSpec\.Env\}\}/,
      );
    });
  });

  /**
   * plano-escala X-07: every service the deploy ships is checked on its
   * own (the roles run the API's image under their own App Name), and the
   * grace each one really has is printed. ROLLOUT_REQUIRE_GRACE=true, set
   * in the host's forced command, holds the API's image and the
   * PgBouncer's to the plan's 40 s; the web and the backup are only
   * printed.
   */
  describe("the grace of every service (X-07)", () => {
    const converged: Step[] = [
      { inspect: `${spec(NEW)}|completed|2`, tasks: [task(NEW), task(NEW)] },
    ];

    /** A converged service of another repository of the organisation. */
    function other(image: string, env: Record<string, string> = {}) {
      const repo = `ghcr.io/trajetto-organization/${image}`;

      return rollout(
        [
          {
            inspect: `${repo}:stable@${NEW}|completed|1`,
            tasks: [
              `t${++taskIds}|${repo}:stable@${NEW}|Running 5 seconds ago`,
            ],
          },
        ],
        [`${image}-staging`, `${repo}@${NEW}`],
        env,
      );
    }

    it("prints the grace in the line that says the service converged", () => {
      writeFileSync(
        `${box.root}/grace`,
        "40000000000|STOP_GRACE_PERIOD_MS=40000\n",
      );

      const result = rollout(converged);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(
        `ok: ${SERVICE} roda ${NEW} em 2 réplica(s) (update: completed) grace=40s`,
      );
    });

    it("checks a role's service with the API's image, its variable included", () => {
      writeFileSync(`${box.root}/grace`, "null|STOP_GRACE_PERIOD_MS=40000\n");

      const result = rollout(converged, ["trajetto-worker-staging", IMAGE]);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("passa de 10000 ms");
    });

    it.each([
      "trajetto-pgbouncer",
      "trajetto-worker",
      "trajetto-scheduler",
      "trajetto-worker-external",
      "trajetto-realtime",
      "trajetto-ingest",
    ])("accepts the image %s", (image) => {
      writeFileSync(`${box.root}/grace`, "90000000000|\n");

      const result = other(image);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("grace=90s");
    });

    it("refuses an image of the organisation it does not know", () => {
      const result = rollout(converged, [
        SERVICE,
        `ghcr.io/trajetto-organization/trajetto-evil@${NEW}`,
      ]);

      expect(result.status).toBe(2);
      expect(box.calls("docker")).toEqual([]);
    });

    it("only prints the web's grace, even when it cannot be read", () => {
      writeFileSync(`${box.root}/grace`, "garbage\n");

      const result = other("trajetto-ui", { ROLLOUT_REQUIRE_GRACE: "true" });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("grace=ilegível");
    });

    describe("with ROLLOUT_REQUIRE_GRACE=true", () => {
      const required = { ROLLOUT_REQUIRE_GRACE: "true" };

      it("fails the API on Docker's 10 s default, saying what to set", () => {
        const result = rollout(converged, undefined, required);

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          "é 10s (o padrão do Docker), abaixo dos 40s que ROLLOUT_REQUIRE_GRACE=true exige",
        );
        expect(result.stderr).toContain("40000000000 ns");
      });

      it("passes the API at 40 s", () => {
        writeFileSync(
          `${box.root}/grace`,
          "40000000000|STOP_GRACE_PERIOD_MS=40000\n",
        );

        const result = rollout(converged, undefined, required);

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("grace=40s");
      });

      it("fails the PgBouncer under 40 s", () => {
        writeFileSync(`${box.root}/grace`, "30000000000|\n");

        const result = other("trajetto-pgbouncer", required);

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("é 30s");
      });

      it("never fails the web or the backup for their grace", () => {
        for (const image of ["trajetto-ui", "trajetto-backup"]) {
          rmSync(`${box.root}/ps.n`, { force: true });
          rmSync(`${box.root}/inspect.n`, { force: true });

          const result = other(image, required);

          expect(result.status, `${image}: ${result.stderr}`).toBe(0);
          expect(result.stdout).toContain("grace=10s");
        }
      });

      it("keeps the old behaviour without it: the API on 10 s passes", () => {
        expect(rollout(converged).status).toBe(0);
      });
    });
  });

  it("fails at the deadline when the update never ends", () => {
    const result = rollout(
      [{ inspect: `${spec(NEW)}|updating|2`, tasks: [task(NEW), task(OLD)] }],
      undefined,
      { ROLLOUT_TIMEOUT_SECONDS: "0" },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/não convergiu para sha256:a{64} em 0s/);
  });

  it("says so when the service does not exist", () => {
    writeFileSync(`${box.root}/missing`, "");

    const result = rollout([{ inspect: "", tasks: [] }]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("não existe");
  });

  it("takes its two words from a forced-command SSH key", () => {
    const result = rollout(
      [{ inspect: `${spec(NEW)}|completed|2`, tasks: [task(NEW), task(NEW)] }],
      [],
      { SSH_ORIGINAL_COMMAND: `${SERVICE} ${IMAGE}` },
    );

    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    ["a tag, which can move while it waits", [SERVICE, `${REPO}:stable`]],
    [
      "another registry",
      [SERVICE, `docker.io/trajetto-organization/trajetto-api@${NEW}`],
    ],
    ["a service with shell in it", [`${SERVICE};id`, IMAGE]],
    ["a second line after a valid service", [`${SERVICE}\nid`, IMAGE]],
    ["a second line after a valid image", [SERVICE, `${IMAGE}\nid`]],
    ["a missing word", [SERVICE]],
    ["an extra word", [SERVICE, IMAGE, "extra"]],
  ])("refuses %s without touching docker", (_, args) => {
    const result = rollout(
      [{ inspect: `${spec(NEW)}|completed|2`, tasks: [task(NEW)] }],
      args,
    );

    expect(result.status).toBe(2);
    expect(box.calls("docker")).toEqual([]);
  });

  it("refuses extra words through the forced command too", () => {
    const result = rollout(
      [{ inspect: `${spec(NEW)}|completed|2`, tasks: [task(NEW)] }],
      [],
      {
        SSH_ORIGINAL_COMMAND: `${SERVICE} ${IMAGE} ; docker swarm leave --force`,
      },
    );

    expect(result.status).toBe(2);
    expect(box.calls("docker")).toEqual([]);
  });
});

/** A site whose /build-id.json answers `answers` in turn (the last repeats). */
let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((done) =>
    server ? server.close(() => done()) : done(),
  );
  server = undefined;
});

type Answer = { sha: string | null } | { status: number };

async function fakeSite(answers: Answer[]) {
  const requests: Array<{ url: string; cacheControl: string | undefined }> = [];

  server = createServer((request: IncomingMessage, response) => {
    requests.push({
      url: request.url ?? "",
      cacheControl: request.headers["cache-control"] as string,
    });

    const answer = answers[Math.min(requests.length - 1, answers.length - 1)];

    if (!(request.url ?? "").startsWith("/build-id.json")) {
      response.statusCode = 404;
      response.end();
      return;
    }

    if ("status" in answer) {
      response.statusCode = answer.status;
      response.end("bad gateway");
      return;
    }

    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ sha: answer.sha }));
  });

  await new Promise<void>((done) =>
    server!.listen(0, "127.0.0.1", () => done()),
  );

  return {
    url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`,
    requests,
  };
}

const WAIT = resolve(WEB, ".github", "scripts", "wait-for-build.mjs");

function waitForBuild(env: Record<string, string>) {
  return new Promise<{ status: number | null; output: string }>((done) => {
    const child = spawn(process.execPath, [WAIT], {
      env: {
        PATH: process.env.PATH ?? "",
        ...(process.env.SystemRoot
          ? { SystemRoot: process.env.SystemRoot }
          : {}),
        WAIT_POLL_SECONDS: "0.01",
        WAIT_TIMEOUT_SECONDS: "2",
        WAIT_STABLE_SECONDS: "0.05",
        ...env,
      },
    });

    let output = "";

    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", (status) => done({ status, output }));
  });
}

const PROMOTED = "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567";
const RUNNING = "fedcba9876543210fedcba9876543210fedcba98";

describe.skipIf(!existsSync(WAIT))(
  "the web rollout check (wait-for-build.mjs)",
  () => {
    it("succeeds once the site has answered the promoted commit for the whole window", async () => {
      const site = await fakeSite([
        { sha: RUNNING },
        { status: 502 },
        { sha: PROMOTED },
      ]);

      const result = await waitForBuild({
        SITE_URL: site.url,
        EXPECTED_SHA: PROMOTED,
      });

      expect(result.status, result.output).toBe(0);
      expect(result.output).toContain(`serve ${PROMOTED}`);
      expect(site.requests.length).toBeGreaterThan(3);
    });

    it("fails when Swarm rolls the build back inside the window", async () => {
      const site = await fakeSite([
        { sha: RUNNING },
        { sha: PROMOTED },
        { sha: PROMOTED },
        { sha: RUNNING },
      ]);

      const result = await waitForBuild({
        SITE_URL: site.url,
        EXPECTED_SHA: PROMOTED,
        WAIT_STABLE_SECONDS: "0.5",
        WAIT_TIMEOUT_SECONDS: "1",
      });

      expect(result.status).not.toBe(0);
      expect(result.output).toContain("voltou a responder");
      expect(result.output).toMatch(
        new RegExp(`não serve ${PROMOTED}.*sha ${RUNNING}`),
      );
    });

    it("fails when the site never serves the promoted commit", async () => {
      const site = await fakeSite([{ sha: RUNNING }]);

      const result = await waitForBuild({
        SITE_URL: site.url,
        EXPECTED_SHA: PROMOTED,
        WAIT_TIMEOUT_SECONDS: "0.2",
      });

      expect(result.status).not.toBe(0);
      expect(result.output).toMatch(/não serve .* após 0\.2s/);
    });

    it("takes the short sha for the full one", async () => {
      const site = await fakeSite([{ sha: PROMOTED }]);

      const result = await waitForBuild({
        SITE_URL: site.url,
        EXPECTED_SHA: PROMOTED.slice(0, 7),
      });

      expect(result.status, result.output).toBe(0);
    });

    it("asks past every cache on each request", async () => {
      const site = await fakeSite([{ sha: PROMOTED }]);

      await waitForBuild({ SITE_URL: site.url, EXPECTED_SHA: PROMOTED });

      const urls = site.requests.map((request) => request.url);

      expect(new Set(urls).size).toBe(urls.length);
      expect(
        site.requests.every((request) => request.cacheControl === "no-cache"),
      ).toBe(true);
    });

    it.each([
      [{ EXPECTED_SHA: PROMOTED }, /Defina SITE_URL/],
      [{ SITE_URL: "https://www.example.com" }, /Defina EXPECTED_SHA/],
      [
        { SITE_URL: "https://www.example.com", EXPECTED_SHA: "main-0a1b2c3" },
        /EXPECTED_SHA precisa/,
      ],
      [
        { SITE_URL: "ftp://www.example.com", EXPECTED_SHA: PROMOTED },
        /http\(s\)/,
      ],
    ])("refuses bad input: %j", async (env, message) => {
      const result = await waitForBuild(env as Record<string, string>);

      expect(result.status).not.toBe(0);
      expect(result.output).toMatch(message);
    });
  },
);

/**
 * Where the deploys live since 10/11/2026: one composite action per
 * repository (.github/actions/deploy), the same code for staging and
 * production, called by the job that carries the environment — `Deploy`
 * (deploy-staging) in staging.yml and `Deploy` (promote-production) in
 * production.yml. The proof of the rollout is in the action; who calls it,
 * with which digest and commit, is in the workflows.
 */
const apiAction = readAction("deploy");
const apiStaging = readWorkflow("staging.yml");
const apiProduction = readWorkflow("production.yml");

/** The `with:` block of the step of `job` that calls the deploy action. */
function caller(workflow: Workflow, job: string, step: string): string {
  const text = stepOf(jobOf(workflow, job), step).text;

  expect(text, `${workflow.file} ${job}`).toContain(
    "uses: ./.github/actions/deploy",
  );

  return text;
}

describe("the API deploy waits for convergence", () => {
  const SSH = "Wait for the rollout to converge";
  const HTTP = "Wait for the API to serve this build";
  const OFF = "Report the rollout as unverified";
  const names = stepNames(apiAction);
  const text = (name: string) => stepOf(apiAction, name).text;

  // plano-escala X-07: the roles' services too, one call each, in the
  // deploy's order: the workers before the API's tag moves (review of wave
  // 12: checked after the API's deploy, a worker that never came up let the
  // API ship), the edge roles after their deploy, through deploy-roles.sh
  // verify.
  it("checks each role's service over SSH in the deploy's order", () => {
    const workers = "Wait for the worker roles to converge";
    const ssh = text(workers);

    expect(ssh).toContain("deploy-roles.sh verify before-api");
    expect(names.indexOf(workers)).toBeGreaterThan(
      names.indexOf("Deploy the worker roles (Dokploy)"),
    );
    expect(names.indexOf(workers)).toBeLessThan(
      names.indexOf("Move the API tag to this build"),
    );
    expect(ssh).toContain("STATE_FILE: ${{ runner.temp }}/deploy-roles.state");

    const edge = "Wait for the edge roles to converge";

    expect(names.indexOf(edge)).toBeGreaterThan(
      names.indexOf("Deploy the edge roles (Dokploy)"),
    );
    expect(conditionOf(stepOf(apiAction, edge))).toBe(
      "steps.head.outputs.current == 'true' && steps.verify.outputs.mode == 'ssh'",
    );
    expect(text(edge)).toContain("deploy-roles.sh verify after-api");

    for (const role of [
      "worker",
      "scheduler",
      "worker-external",
      "ingest",
      "realtime",
    ]) {
      const variable = `SWARM_${role.toUpperCase().replace("-", "_")}_SERVICE`;
      const step = ["ingest", "realtime"].includes(role) ? text(edge) : ssh;

      expect(step, role).toContain(
        `${variable}: \${{ inputs.swarm-${role}-service }}`,
      );

      for (const [workflow, job, caller_] of [
        [apiStaging, "deploy-staging", "Deploy to staging"],
        [apiProduction, "promote-production", "Deploy to production"],
      ] as const) {
        expect(caller(workflow, job, caller_), `${job} ${role}`).toContain(
          `swarm-${role}-service: \${{ vars.${variable} }}`,
        );
      }
    }
  });

  it("checks the running digest over SSH after the API's own deploy", () => {
    expect(names.indexOf("Deploy the API (Dokploy)")).toBeGreaterThan(-1);
    expect(names.indexOf(SSH)).toBeGreaterThan(
      names.indexOf("Deploy the API (Dokploy)"),
    );
    expect(text(SSH)).toContain("DIGEST: ${{ inputs.api-digest }}");
    expect(text(SSH)).toContain("SSH_KEY: ${{ inputs.deploy-verify-ssh-key }}");
    expect(text(SSH)).toContain(
      '"$SERVICE ghcr.io/trajetto-organization/trajetto-api@${DIGEST}"',
    );
    expect(names).toContain(OFF);
  });

  // The digest the check waits for is the one this deploy shipped, and the
  // key is the environment's: both come from the job that carries it.
  it.each([
    [
      apiStaging,
      "deploy-staging",
      "Deploy to staging",
      "needs.build.outputs.api_digest",
    ],
    [
      apiProduction,
      "promote-production",
      "Deploy to production",
      "needs.evidence.outputs.api_digest",
    ],
  ])(
    "%#: the caller hands it the digest it deploys and the key",
    (workflow, job, step, digest) => {
      const call = caller(workflow, job, step);

      expect(call).toContain(`api-digest: \${{ ${digest} }}`);
      expect(call).toContain(
        "deploy-verify-ssh-key: ${{ secrets.DEPLOY_VERIFY_SSH_KEY }}",
      );
      expect(call).toContain("rollout-verify: ${{ vars.ROLLOUT_VERIFY }}");
      expect(call).toContain("api-public-url: ${{ vars.API_PUBLIC_URL }}");
    },
  );

  it("moves the environment's tag to the same digest it then waits for", () => {
    const move = text("Move the API tag to this build");

    expect(names.indexOf("Move the API tag to this build")).toBeLessThan(
      names.indexOf("Deploy the API (Dokploy)"),
    );
    expect(move).toContain("API_DIGEST: ${{ inputs.api-digest }}");
    expect(move).toContain(
      '"ghcr.io/trajetto-organization/trajetto-api@${API_DIGEST}"',
    );
  });

  it("waits, without SSH, for the public liveness to answer the expected commit", () => {
    expect(names.indexOf(HTTP)).toBeGreaterThan(
      names.indexOf("Deploy the API (Dokploy)"),
    );
    expect(text(HTTP)).toContain("API_URL: ${{ inputs.api-public-url }}");
    expect(text(HTTP)).toContain("EXPECTED_SHA: ${{ inputs.expected-commit }}");
    expect(text(HTTP)).toContain("node .github/scripts/wait-for-version.mjs");
    expect(caller(apiStaging, "deploy-staging", "Deploy to staging")).toContain(
      "expected-commit: ${{ github.sha }}",
    );
    // The tag without its prefix: `sha-<7>` is all a rollback knows, and the
    // script takes a prefix of the commit.
    expect(
      caller(apiProduction, "promote-production", "Deploy to production"),
    ).toContain("expected-commit: ${{ needs.evidence.outputs.expected }}");
  });

  /**
   * Two ways to prove the rollout: the Swarm tasks over SSH
   * (verify-rollout.sh), or the public /health/liveness answering the new
   * commit (wait-for-version.mjs), which needs no key on the host. Staging
   * ran with ROLLOUT_VERIFY=off because SSH was the only one; now the public
   * check is its default, and production keeps SSH as its own. Whatever the
   * variable says, exactly one check runs — an unknown value falls back to
   * the default, never to none — and only `off` skips them, logged. The
   * pick runs for real; each check's `if` is read against its answer.
   */
  describe.skipIf(!hasShell("bash"))("exactly one rollout check", () => {
    let box: Sandbox;

    beforeEach(() => {
      box = sandbox();
    });

    afterEach(() => box.dispose());

    /** The `if` of a check, given the mode the pick wrote. */
    const runs = (name: string, mode: string) => {
      const expression = conditionOf(stepOf(apiAction, name));
      const clauses = expression.split(" && ");

      expect(expression, name).not.toContain("||");
      expect(clauses[0], name).toBe("steps.head.outputs.current == 'true'");

      return clauses.slice(1).every((clause) => {
        const match = /^steps\.verify\.outputs\.mode (==|!=) '([^']*)'$/.exec(
          clause,
        );

        expect(match, `${name}: ${clause}`).not.toBeNull();

        return match?.[1] === "==" ? mode === match[2] : mode !== match?.[2];
      });
    };

    // The pick below runs the script with ROLLOUT_VERIFY and DEFAULT set by
    // hand; what links them to the environment's variable is this chain:
    // vars.ROLLOUT_VERIFY → the caller's `with:` → the action's input → the
    // step's `env:`. A swapped or wrong input there (DEFAULT reading
    // rollout-verify) would change which check production runs, green.
    it("hands the environment's ROLLOUT_VERIFY and the job's default to the pick", () => {
      const pick = stepOf(apiAction, "Pick the rollout check").text;

      expect(pick).toContain("ROLLOUT_VERIFY: ${{ inputs.rollout-verify }}");
      expect(pick).toContain("DEFAULT: ${{ inputs.verify-default }}");
      for (const [workflow, job, step] of [
        [apiStaging, "deploy-staging", "Deploy to staging"],
        [apiProduction, "promote-production", "Deploy to production"],
      ] as const) {
        expect(caller(workflow, job, step), job).toContain(
          "rollout-verify: ${{ vars.ROLLOUT_VERIFY }}",
        );
      }
    });

    it.each([
      [apiStaging, "deploy-staging", "Deploy to staging", "http"],
      [apiProduction, "promote-production", "Deploy to production", "ssh"],
    ])(
      "%#: %s, %s by default, runs exactly one unless ROLLOUT_VERIFY=off",
      (workflow, job, step, byDefault) => {
        expect(caller(workflow, job, step)).toContain(
          `verify-default: ${byDefault}`,
        );

        const pick = (value: string) =>
          runBlock(box, stepOf(apiAction, "Pick the rollout check").run, {
            ROLLOUT_VERIFY: value,
            DEFAULT: byDefault,
          }).outputs.mode;

        for (const value of ["", "http", "ssh", "on", "true"]) {
          const mode = pick(value);

          expect(
            [runs(HTTP, mode), runs(SSH, mode), runs(OFF, mode)],
            `ROLLOUT_VERIFY='${value}'`,
          ).toEqual(
            value === "http" || (value !== "ssh" && byDefault === "http")
              ? [true, false, false]
              : [false, true, false],
          );
        }

        const off = pick("off");

        expect([runs(HTTP, off), runs(SSH, off), runs(OFF, off)]).toEqual([
          false,
          false,
          true,
        ]);
      },
    );
  });
});

/**
 * The web's deploy, since 10/11/2026: trajetto-ui/.github/actions/deploy,
 * called by the same two jobs. A web still on the single deploy.yml (before
 * that day) is checked further down, in that file; a web on neither layout
 * fails here, instead of these checks going quiet.
 */
const WEB_ACTION = resolve(WEB, ".github", "actions", "deploy", "action.yml");
const WEB_LEGACY = resolve(WEB, ".github", "workflows", "deploy.yml");
const webWorkflow = (name: string) =>
  workflowOf(name, read(WEB, ".github", "workflows", name));
const web = existsSync(WEB_ACTION)
  ? {
      action: actionOf("deploy", WEB_ACTION, read(WEB_ACTION)),
      staging: webWorkflow("staging.yml"),
      production: webWorkflow("production.yml"),
    }
  : undefined;

it("knows the web's layout, when the web is there", () => {
  if (!existsSync(resolve(WEB, "package.json"))) return;

  expect(
    existsSync(WEB_ACTION) || existsSync(WEB_LEGACY),
    "trajetto-ui sem .github/actions/deploy nem .github/workflows/deploy.yml",
  ).toBe(true);
});

describe.skipIf(!web)("the web deploy waits for convergence", () => {
  const action = web?.action as Action;
  const WAIT = "Wait for the site to serve this build";

  it("reads /build-id.json right after Dokploy, for the commit it was handed", () => {
    const names = stepNames(action);
    const wait = stepOf(action, WAIT).text;

    expect(names.indexOf(WAIT)).toBe(
      names.indexOf("Deploy the site (Dokploy)") + 1,
    );
    expect(wait).toContain("EXPECTED_SHA: ${{ inputs.expected-sha }}");
    expect(wait).toContain("node .github/scripts/wait-for-build.mjs");
    expect(conditionOf(stepOf(action, WAIT))).toBe(
      "steps.dokploy.outputs.enabled == 'true' && inputs.rollout-verify != 'off'",
    );
    expect(
      conditionOf(stepOf(action, "Report the rollout as unverified")),
    ).toBe("inputs.rollout-verify == 'off'");
  });

  it.each([
    ["staging", "deploy-staging", "Deploy to staging", "github.sha"],
    [
      "production",
      "promote-production",
      "Deploy to production",
      "needs.evidence.outputs.sha",
    ],
  ])(
    "%s: the caller hands it the commit of the image it deploys",
    (environment, job, step, sha) => {
      const workflow =
        environment === "staging" ? web!.staging : web!.production;
      const call = caller(workflow, job, step);

      expect(call).toContain(`expected-sha: \${{ ${sha} }}`);
      expect(call).toContain("rollout-verify: ${{ vars.ROLLOUT_VERIFY }}");
    },
  );
});

/**
 * A web still on the single deploy.yml: its `staging` until its first push
 * with the new layout, which the API's CI reads in the meantime. The same
 * guarantees as for the new layout, read in that file, so neither layout
 * leaves the API without checking the web: both deploy jobs read
 * /build-id.json right after Dokploy unless ROLLOUT_VERIFY=off, neither
 * overlaps itself, only the branch head moves `staging`, and the build
 * publishes no mutable `staging` tag. The names are that file's own.
 */
const webLegacy =
  !web && existsSync(WEB_LEGACY)
    ? workflowOf("deploy.yml", read(WEB_LEGACY))
    : undefined;

describe.skipIf(!webLegacy)("the web deploy, still on deploy.yml", () => {
  const deploy = webLegacy as Workflow;

  it.each([
    [
      "promote-production",
      "Deploy to production (Dokploy)",
      "Wait for the site to serve the promoted build",
      "${{ steps.revision.outputs.sha }}",
    ],
    [
      "deploy-staging",
      "Deploy to staging (Dokploy)",
      "Wait for the site to serve this build",
      "${{ github.sha }}",
    ],
  ])(
    "%s reads /build-id.json right after Dokploy",
    (job, dokploy, wait, sha) => {
      const each = jobOf(deploy, job);
      const names = stepNames(each);
      const step = stepOf(each, wait);

      expect(names.indexOf(wait)).toBe(names.indexOf(dokploy) + 1);
      expect(step.text).toContain(`EXPECTED_SHA: ${sha}`);
      expect(step.text).toContain("node .github/scripts/wait-for-build.mjs");
      expect(conditionOf(step)).toMatch(/ && vars\.ROLLOUT_VERIFY != 'off'$/);
    },
  );

  it("deploy-staging and promote-production never overlap themselves", () => {
    for (const job of ["deploy-staging", "promote-production"]) {
      expect(jobOf(deploy, job).text, job).toMatch(
        new RegExp(
          `\\n {4}concurrency:\\n {6}group: ${job}\\n {6}cancel-in-progress: false\\n`,
        ),
      );
    }
  });

  it("moves `staging` only when this run is still the branch head", () => {
    const { steps } = jobOf(deploy, "deploy-staging");
    const head = steps.findIndex((step) =>
      /^Is this run still .+ head\?$/.test(step.name),
    );

    expect(head).toBeGreaterThan(-1);
    expect(steps[head].text).toContain('git ls-remote origin "$GITHUB_REF"');
    expect(head).toBeLessThan(
      steps.findIndex((step) => step.name === "Move staging to this build"),
    );
    for (const step of steps.slice(head + 1)) {
      expect(step.text, step.name).toMatch(
        /\n\s+if: steps\.head\.outputs\.current == 'true'/,
      );
    }
  });

  it("publishes no mutable `staging` tag at build time, and moves it by digest", () => {
    const build = jobOf(deploy, "build").text;

    expect(build.startsWith("  build:")).toBe(true);
    expect(build).not.toContain("type=raw,value=staging");
    expect(jobOf(deploy, "deploy-staging").text).toContain(
      '"ghcr.io/trajetto-organization/trajetto-ui@${DIGEST}"',
    );
  });
});

/**
 * Runs finish out of order. An older push whose build was slower moved
 * `staging` BACK after a newer run had moved it forward, and two Dokploy
 * calls on one app could overlap (each script follows the first deployment
 * missing from its snapshot — possibly the other run's).
 */
describe("one deploy at a time, and staging only from the branch head", () => {
  const HEAD = "Check run is branch head";
  const repositories: Array<[string, Workflow, Workflow]> = [
    ["trajetto-api", apiStaging, apiProduction],
    ...(web
      ? [
          ["trajetto-ui", web.staging, web.production] as [
            string,
            Workflow,
            Workflow,
          ],
        ]
      : []),
  ];

  it.each(repositories)(
    "%s: deploy-staging and promote-production never overlap themselves",
    (_, staging, production) => {
      for (const [workflow, job] of [
        [staging, "deploy-staging"],
        [production, "promote-production"],
      ] as const) {
        expect(jobOf(workflow, job).text, job).toMatch(
          new RegExp(
            `\\n {4}concurrency:\\n {6}group: ${job}\\n {6}cancel-in-progress: false\\n`,
          ),
        );
      }
    },
  );

  /** Every step after the head check runs only on its answer. */
  function gatedAfterHead(steps: Array<{ name: string; text: string }>) {
    const head = steps.findIndex((step) => step.name === HEAD);

    expect(head).toBeGreaterThan(-1);
    expect(steps[head].text).toContain("id: head");
    expect(steps[head].text).toContain('git ls-remote origin "$GITHUB_REF"');

    for (const step of steps.slice(head + 1)) {
      expect(step.text, step.name).toMatch(
        /\n\s+if: steps\.head\.outputs\.current == 'true'/,
      );
    }

    return steps.map((step) => step.name);
  }

  // The API's check is in the deploy action, asked for by staging only:
  // production deploys what was approved.
  it("trajetto-api: moves the tags only when this run is still the branch head", () => {
    const names = gatedAfterHead(apiAction.steps);

    for (const move of [
      "Move the release image tag to this build",
      "Move the AI tag to this build",
      "Move the API tag to this build",
    ]) {
      expect(names.indexOf(HEAD), move).toBeLessThan(names.indexOf(move));
    }
    expect(caller(apiStaging, "deploy-staging", "Deploy to staging")).toContain(
      'require-branch-head: "true"',
    );
    expect(
      caller(apiProduction, "promote-production", "Deploy to production"),
    ).toContain('require-branch-head: "false"');
  });

  it.skipIf(!web)(
    "trajetto-ui: moves `staging` only when this run is still the branch head",
    () => {
      const names = gatedAfterHead(jobOf(web!.staging, "deploy-staging").steps);

      expect(names.indexOf(HEAD)).toBeLessThan(
        names.indexOf("Move the site tag to this build"),
      );
    },
  );

  it.skipIf(!web)(
    "trajetto-ui: publishes no mutable `staging` tag at build time, and moves both by digest",
    () => {
      // The web's single build job publishes only candidate-<7>; the old name
      // `build-staging` no longer exists, and a missing job made this vacuous.
      const build = jobOf(web!.staging, "build").text;

      expect(build.startsWith("  build:")).toBe(true);
      expect(build).toContain("type=sha,prefix=candidate-");
      expect(build).not.toContain("type=raw,value=staging");
      expect(jobOf(web!.staging, "deploy-staging").text).toContain(
        '"ghcr.io/trajetto-organization/trajetto-ui@${DIGEST}"',
      );

      const promote = stepOf(
        jobOf(web!.production, "promote-production"),
        "Move the site tag to this build",
      ).text;

      expect(promote).toContain("DIGEST: ${{ needs.evidence.outputs.digest }}");
      expect(promote).toContain(
        '"ghcr.io/trajetto-organization/trajetto-ui@${DIGEST}"',
      );
      expect(promote).toContain("trajetto-ui:stable");
    },
  );
});
