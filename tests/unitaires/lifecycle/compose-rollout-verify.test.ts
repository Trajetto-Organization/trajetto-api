import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  hasShell,
  repoFile,
  run,
  sandbox,
  type Sandbox,
} from "./support/shell-harness";

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
 * container is not on this node).
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
  const inspections = () =>
    box
      .calls("docker")
      .filter(
        (call) =>
          call.startsWith("docker service inspect") &&
          call.includes("--format"),
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

/**
 * The other forced command on the same host had the same hole: `printf |
 * grep '^...$'` matches line by line, so an image whose FIRST line was valid
 * passed whole, newline and all, on its way to a docker command line.
 */
describe.skipIf(!sh)("the release-migration forced command", () => {
  let box: Sandbox;

  beforeEach(() => {
    box = sandbox();
    box.stub("docker", "exit 0");
  });

  afterEach(() => box.dispose());

  it("refuses an image with a second line, without touching docker", () => {
    const image =
      "ghcr.io/trajetto-organization/trajetto-api:main-0a1b2c3\n--network host";

    const inputs: Array<{ args: string[]; env: Record<string, string> }> = [
      { args: [image], env: {} },
      { args: [], env: { SSH_ORIGINAL_COMMAND: image } },
    ];

    for (const input of inputs) {
      const result = run(
        "sh",
        repoFile("infra/scripts/run-release-migrations.sh"),
        input.args,
        {
          bin: box.bin,
          env: { MIGRATE_POLL_SECONDS: "0", ...input.env },
        },
      );

      expect(result.status).toBe(2);
    }

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

/** Steps of a job, by name, in order. */
function stepsOf(
  workflow: string,
  job: string,
): Array<{ name: string; text: string }> {
  const start = workflow.indexOf(`\n  ${job}:\n`);

  if (start < 0) return [];

  const rest = workflow.slice(start + 1);
  const end = rest.slice(1).search(/\n {2}[\w-]+:\n/);
  const text = end < 0 ? rest : rest.slice(0, end + 1);

  return text
    .split(/\n {6}- name: /)
    .slice(1)
    .map((chunk) => ({ name: chunk.split("\n")[0], text: chunk }));
}

function jobText(workflow: string, job: string): string {
  const start = workflow.indexOf(`\n  ${job}:\n`);
  const rest = workflow.slice(start + 1);
  const end = rest.slice(1).search(/\n {2}[\w-]+:\n/);

  return end < 0 ? rest : rest.slice(0, end + 1);
}

const apiDeploy = read(ROOT, ".github", "workflows", "deploy.yml");

describe("the API deploy jobs wait for convergence", () => {
  it.each([
    [
      "promote-production",
      "Deploy to production (Dokploy)",
      "${{ steps.stable.outputs.digest }}",
    ],
    [
      "deploy-staging",
      "Deploy to staging (Dokploy)",
      "${{ needs.build-and-push.outputs.api_digest }}",
    ],
  ])("%s checks the running digest after Dokploy", (job, deploy, digest) => {
    const steps = stepsOf(apiDeploy, job);
    const names = steps.map((step) => step.name);
    const wait =
      steps.find((step) => step.name === "Wait for the rollout to converge")
        ?.text ?? "";

    // After the API's own deploy (the backup Application's deploy may sit in
    // between: it does not touch the API service).
    expect(names.indexOf(deploy)).toBeGreaterThan(-1);
    expect(names.indexOf("Wait for the rollout to converge")).toBeGreaterThan(
      names.indexOf(deploy),
    );
    expect(wait).toContain(`DIGEST: ${digest}`);
    expect(wait).toContain("SSH_KEY: ${{ secrets.DEPLOY_VERIFY_SSH_KEY }}");
    expect(wait).toContain(
      '"$SERVICE ghcr.io/trajetto-organization/trajetto-api@${DIGEST}"',
    );
    // Required: the only way around it is the explicit, logged opt-out.
    expect(wait).toMatch(/if: .*vars\.ROLLOUT_VERIFY != 'off'/);
    expect(names).toContain("Say the rollout was not verified");
  });

  it("promotes by the digest it then waits for", () => {
    const promote = stepsOf(apiDeploy, "promote-production").find(
      (step) => step.name === "Promote image to stable",
    )?.text;

    expect(promote).toContain("id: stable");
    expect(promote).toContain('echo "digest=${digest}" >> "$GITHUB_OUTPUT"');
    expect(promote).toContain(
      '"ghcr.io/trajetto-organization/trajetto-api@${digest}"',
    );
  });
});

describe.skipIf(
  !existsSync(resolve(WEB, ".github", "workflows", "deploy.yml")),
)("the web deploy jobs wait for convergence", () => {
  const webDeploy = existsSync(WEB)
    ? read(WEB, ".github", "workflows", "deploy.yml")
    : "";

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
  ])("%s reads /build-id.json after Dokploy", (job, deploy, waitName, sha) => {
    const steps = stepsOf(webDeploy, job);
    const names = steps.map((step) => step.name);
    const wait = steps.find((step) => step.name === waitName)?.text ?? "";

    expect(names.indexOf(waitName)).toBe(names.indexOf(deploy) + 1);
    expect(wait).toContain(`EXPECTED_SHA: ${sha}`);
    expect(wait).toContain("node .github/scripts/wait-for-build.mjs");
    expect(wait).toMatch(/if: .*vars\.ROLLOUT_VERIFY != 'off'/);
  });
});

/**
 * Runs finish out of order. An older push whose build was slower moved
 * `staging` BACK after a newer run had moved it forward, and two Dokploy
 * calls on one app could overlap (each script follows the first deployment
 * missing from its snapshot — possibly the other run's).
 */
describe("one deploy at a time, and staging only from the branch head", () => {
  const workflows: Array<[string, string]> = [
    ["trajetto-api", apiDeploy],
    ...(existsSync(resolve(WEB, ".github", "workflows", "deploy.yml"))
      ? [
          ["trajetto-ui", read(WEB, ".github", "workflows", "deploy.yml")] as [
            string,
            string,
          ],
        ]
      : []),
  ];

  it.each(workflows)(
    "%s: deploy-staging and promote-production never overlap themselves",
    (_, workflow) => {
      for (const job of ["deploy-staging", "promote-production"]) {
        expect(jobText(workflow, job), job).toMatch(
          new RegExp(
            `\\n {4}concurrency:\\n {6}group: ${job}\\n {6}cancel-in-progress: false\\n`,
          ),
        );
      }
    },
  );

  // The branch that deploys staging is `staging` in the API (it was `main`
  // before the staging branch existed); the step's name says which one.
  it.each(workflows)(
    "%s: moves `staging` only when this run is still the branch head",
    (_, workflow) => {
      const steps = stepsOf(workflow, "deploy-staging");
      const names = steps.map((step) => step.name);
      const head = names.findIndex((name) =>
        /^Is this run still .+ head\?$/.test(name),
      );

      expect(head).toBeGreaterThan(-1);
      expect(steps[head].text).toContain('git ls-remote origin "$GITHUB_REF"');
      expect(head).toBeLessThan(names.indexOf("Move staging to this build"));

      for (const step of steps.slice(head + 1)) {
        expect(step.text, step.name).toMatch(
          /if: steps\.head\.outputs\.current == 'true'/,
        );
      }
    },
  );

  it("the web publishes no mutable `staging` tag at build time", () => {
    if (workflows.length < 2) return;

    // The web's single build job (it only publishes main-<sha>). The old name
    // `build-staging` no longer exists, and a missing job made this vacuous.
    const build = jobText(workflows[1][1], "build");

    expect(build.startsWith("  build:")).toBe(true);
    expect(build).not.toContain("type=raw,value=staging");
    expect(jobText(workflows[1][1], "deploy-staging")).toContain(
      '"ghcr.io/trajetto-organization/trajetto-ui@${DIGEST}"',
    );
  });
});
