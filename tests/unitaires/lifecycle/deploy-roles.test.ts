import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runBlock } from "./support/run-block";
import { hasShell, run, sandbox, type Sandbox } from "./support/shell-harness";
import {
  conditionOf,
  jobOf,
  readAction,
  readWorkflow,
  stepNames,
  stepOf,
} from "./support/workflow-text";

/**
 * The deploy of the Applications that run the API's image in another role
 * (plano-escala F3-31a): worker, scheduler, worker-external, ingest and
 * realtime, through .github/scripts/deploy-roles.sh and the deploy action.
 *
 * Why each property matters:
 *  - one tag per role (`<tag>-<role>`), moved right before the role's own
 *    deploy: one tag for all would let the Swarm pull the new build out of
 *    order on any task restart, a worker before the migrations;
 *  - the workers before the API, the edge roles after it;
 *  - a role's failed deploy stops everything after it, the API included,
 *    and on staging its tag goes back;
 *  - without the new secrets the run deploys exactly what it did before,
 *    and the roles' tags follow the API's digest once the run is green;
 *  - a rollback moves them all, since every role runs the API's digest.
 *
 * The script runs with docker (GHCR, through ghcr.sh) and node (the
 * Dokploy deploy) stubbed: a tag table stands in for GHCR.
 */
const SCRIPT = ".github/scripts/deploy-roles.sh";
const REPO = "ghcr.io/trajetto-organization/trajetto-api";
const digest = (char: string) => `sha256:${char.repeat(64)}`;
const API = digest("1");
const deploy = readAction("deploy");
const ROLES = ["worker", "scheduler", "worker-external", "ingest", "realtime"];

describe.skipIf(!hasShell("bash"))("deploy-roles.sh", () => {
  let box: Sandbox;
  let state: string;

  beforeEach(() => {
    box = sandbox();
    state = `${box.root}/deploy-roles.state`;

    // GHCR: `imagetools inspect <ref>` answers from the tag table and
    // `imagetools create --tag <new> <source>` writes it there, failing
    // for any ref listed in `refuse`.
    box.stub(
      "docker",
      [
        'if [ "$1 $2 $3" = "buildx imagetools inspect" ]; then',
        `  found=$(awk -v ref="$4" '$1 == ref { value = $2 } END { print value }' "${box.root}/tags")`,
        '  [ -n "$found" ] || { echo "not found" >&2; exit 1; }',
        '  printf "%s\\n" "$found"',
        "fi",
        'if [ "$1 $2 $3" = "buildx imagetools create" ]; then',
        `  if grep -qxF "$5" "${box.root}/refuse" 2>/dev/null; then echo "503 service unavailable" >&2; exit 1; fi`,
        `  printf '%s %s\\n' "$5" "\${6#*@}" >> "${box.root}/tags"`,
        "fi",
      ].join("\n"),
    );
    // The Dokploy deploy: an id starting with `fail` fails.
    box.stub(
      "node",
      [
        `printf '%s %s\\n' "$DOKPLOY_APP_LABEL" "$DOKPLOY_APPLICATION_ID" >> "${box.root}/deploys"`,
        'case "$DOKPLOY_APPLICATION_ID" in fail*) exit 1 ;; esac',
      ].join("\n"),
    );
    box.stub("sleep", "exit 0");
    writeFileSync(`${box.root}/tags`, "");
  });

  afterEach(() => box.dispose());

  function tags(table: Record<string, string>) {
    writeFileSync(
      `${box.root}/tags`,
      Object.entries(table)
        .map(([ref, value]) => `${REPO}:${ref} ${value}\n`)
        .join(""),
    );
  }

  function roles(phase: string, env: Record<string, string> = {}) {
    return run("bash", SCRIPT, [phase], {
      bin: box.bin,
      cwd: process.cwd(),
      env: {
        TAG: "staging",
        API_DIGEST: API,
        STATE_FILE: state,
        DOKPLOY_ENABLED: "true",
        GHCR_ATTEMPTS: "1",
        GITHUB_STEP_SUMMARY: `${box.root}/summary`,
        ...env,
      },
    });
  }

  const deploys = () =>
    existsSync(`${box.root}/deploys`)
      ? readFileSync(`${box.root}/deploys`, "utf8").split("\n").filter(Boolean)
      : [];

  /** What the tag table names for `<tag>`, the newest line winning. */
  function tagOf(ref: string): string | undefined {
    const lines = readFileSync(`${box.root}/tags`, "utf8")
      .split("\n")
      .filter((line) => line.startsWith(`${REPO}:${ref} `));

    return lines[lines.length - 1]?.split(" ")[1];
  }

  const recorded = () =>
    existsSync(state)
      ? readFileSync(state, "utf8").split("\n").filter(Boolean)
      : [];

  describe("without the new secrets", () => {
    it("deploys nothing, says which roles it skipped, and moves no tag yet", () => {
      const before = roles("before-api");
      const after = roles("after-api");

      expect(before.status, before.stderr).toBe(0);
      expect(after.status, after.stderr).toBe(0);
      expect(deploys()).toEqual([]);
      expect(box.calls("docker")).toEqual([]);

      expect(before.stdout).toContain(
        "::notice::Sem o id da Application no environment do GitHub (DOKPLOY_<PAPEL>_APPLICATION_ID, docs/deploy.md): trajetto-worker trajetto-scheduler trajetto-worker-external não são implantados",
      );
      expect(after.stdout).toContain("trajetto-ingest trajetto-realtime");
      expect(recorded()).toEqual(ROLES.map((role) => `${role} absent -`));
    });

    it("moves every role's tag to the API's digest once the run is green", () => {
      roles("before-api");
      roles("after-api");

      const follow = roles("follow");

      expect(follow.status, follow.stderr).toBe(0);

      for (const role of ROLES) {
        expect(tagOf(`staging-${role}`), role).toBe(API);
      }

      expect(readFileSync(`${box.root}/summary`, "utf8")).toContain(
        "staging-worker staging-scheduler staging-worker-external staging-ingest staging-realtime",
      );
    });

    it("moves them too when the environment has no Dokploy at all", () => {
      // No phase ran: nothing was recorded, and the tags still follow.
      const follow = roles("follow", { STATE_FILE: "" });

      expect(follow.status, follow.stderr).toBe(0);
      expect(tagOf("staging-realtime")).toBe(API);
    });
  });

  describe("a role with its Application id", () => {
    it("moves its own tag to the API's digest right before its own deploy", () => {
      tags({ "staging-worker": digest("0") });

      const result = roles("before-api", {
        DOKPLOY_WORKER_APPLICATION_ID: "app-worker",
      });

      expect(result.status, result.stderr).toBe(0);
      expect(deploys()).toEqual(["trajetto-worker app-worker"]);
      expect(tagOf("staging-worker")).toBe(API);

      // The move, then the deploy.
      const order = box
        .calls()
        .filter(
          (call) =>
            call.startsWith("node ") || call.includes("imagetools create"),
        );

      expect(order).toEqual([
        `docker buildx imagetools create --tag ${REPO}:staging-worker ${REPO}@${API}`,
        "node .github/scripts/dokploy-deploy.mjs",
      ]);
      expect(recorded()).toEqual([
        `worker deployed ${digest("0")}`,
        "scheduler absent -",
        "worker-external absent -",
      ]);
    });

    it("deploys the workers in order, and is skipped by the follow step", () => {
      const result = roles("before-api", {
        DOKPLOY_WORKER_APPLICATION_ID: "app-worker",
        DOKPLOY_SCHEDULER_APPLICATION_ID: "app-scheduler",
        DOKPLOY_WORKER_EXTERNAL_APPLICATION_ID: "app-external",
      });

      expect(result.status, result.stderr).toBe(0);
      expect(deploys()).toEqual([
        "trajetto-worker app-worker",
        "trajetto-scheduler app-scheduler",
        "trajetto-worker-external app-external",
      ]);

      roles("after-api", { DOKPLOY_INGEST_APPLICATION_ID: "app-ingest" });
      expect(deploys().slice(-1)).toEqual(["trajetto-ingest app-ingest"]);

      const created = () =>
        box.calls("docker").filter((call) => call.includes("create")).length;
      const before = created();

      roles("follow");

      // Only the realtime had no id: one tag moved by the follow step.
      expect(created() - before).toBe(1);
      expect(tagOf("staging-realtime")).toBe(API);
    });
  });

  describe("a role whose deploy fails", () => {
    it("stops the roles after it, says the API is not deployed, and records the tag to put back", () => {
      tags({ "staging-worker": digest("0") });

      const result = roles("before-api", {
        DOKPLOY_WORKER_APPLICATION_ID: "fail-worker",
        DOKPLOY_SCHEDULER_APPLICATION_ID: "app-scheduler",
      });

      expect(result.status).not.toBe(0);
      expect(result.stdout).toContain(
        "::error::O deploy de trajetto-worker falhou: nada depois dele foi implantado (a API inclusive)",
      );
      expect(deploys()).toEqual(["trajetto-worker fail-worker"]);
      expect(recorded()).toEqual([`worker failed ${digest("0")}`]);
    });

    it("gets its tag back on staging, and only its own", () => {
      tags({
        "staging-worker": digest("0"),
        "staging-scheduler": digest("9"),
      });

      roles("before-api", {
        DOKPLOY_SCHEDULER_APPLICATION_ID: "app-scheduler",
        DOKPLOY_WORKER_APPLICATION_ID: "app-worker",
      });
      writeFileSync(
        state,
        `${readFileSync(state, "utf8")}ingest failed ${digest("7")}\n`,
      );

      const restore = roles("restore", { RESTORE_TAGS: "true" });

      expect(restore.status, restore.stderr).toBe(0);
      expect(tagOf("staging-ingest")).toBe(digest("7"));
      // The deployed ones stay on the new build.
      expect(tagOf("staging-worker")).toBe(API);
      expect(tagOf("staging-scheduler")).toBe(API);
    });

    it("keeps its tag in production, where a failed promote is promoted again", () => {
      writeFileSync(state, `worker failed ${digest("0")}\n`);

      const restore = roles("restore", {
        TAG: "stable",
        RESTORE_TAGS: "false",
      });

      expect(restore.status, restore.stderr).toBe(0);
      expect(box.calls("docker")).toEqual([]);
    });

    it("leaves a tag that did not exist before where it is, with a warning", () => {
      writeFileSync(state, "worker failed -\n");

      const restore = roles("restore", { RESTORE_TAGS: "true" });

      expect(restore.status, restore.stderr).toBe(0);
      expect(restore.stdout).toContain(
        "::warning::trajetto-api:staging-worker não existia antes deste run",
      );
      expect(box.calls("docker")).toEqual([]);
    });

    it("finds nothing to put back when nothing was recorded", () => {
      const restore = roles("restore", {
        RESTORE_TAGS: "true",
        STATE_FILE: "",
      });

      expect(restore.status, restore.stderr).toBe(0);
      expect(box.calls("docker")).toEqual([]);
    });
  });

  describe("GHCR not answering", () => {
    it("fails a role's deploy before anything moved", () => {
      box.stub("docker", 'echo "503 service unavailable" >&2; exit 1');

      const result = roles("before-api", {
        DOKPLOY_WORKER_APPLICATION_ID: "app-worker",
      });

      expect(result.status).not.toBe(0);
      expect(deploys()).toEqual([]);
    });

    it("only warns in the follow step: the deploy already converged", () => {
      writeFileSync(`${box.root}/refuse`, `${REPO}:staging-scheduler\n`);

      const follow = roles("follow");

      expect(follow.status, follow.stderr).toBe(0);
      expect(follow.stdout + follow.stderr).toContain(
        "::warning::A tag trajetto-api:staging-scheduler não andou",
      );
      expect(tagOf("staging-worker")).toBe(API);
    });
  });

  it("refuses a phase it does not know", () => {
    expect(roles("everything").status).toBe(2);
  });
});

describe("the deploy action", () => {
  const at = (name: string) => stepNames(deploy).indexOf(name);

  it("deploys the workers after the AI and before the API, the edge roles once the API's check passed", () => {
    const order = [
      "Deploy the AI service (Dokploy)",
      "Deploy the worker roles (Dokploy)",
      "Move the API tag to this build",
      "Deploy the API (Dokploy)",
      "Pick the rollout check",
      "Wait for the API to serve this build",
      "Wait for the rollout to converge",
      "Deploy the edge roles (Dokploy)",
      "Move the tags of the roles not deployed",
      "Mark this build as staged",
      "Put the tags back after a failed deploy",
    ];

    for (const name of order) expect(at(name), name).toBeGreaterThan(-1);

    expect(order.map(at)).toEqual([...order.map(at)].sort((a, b) => a - b));
  });

  it("runs the roles' deploys only with Dokploy, and their tags' follow without it", () => {
    for (const name of [
      "Deploy the worker roles (Dokploy)",
      "Deploy the edge roles (Dokploy)",
    ]) {
      expect(conditionOf(stepOf(deploy, name)), name).toBe(
        "steps.head.outputs.current == 'true' && steps.dokploy.outputs.enabled == 'true'",
      );
    }

    expect(
      conditionOf(stepOf(deploy, "Move the tags of the roles not deployed")),
    ).toBe("steps.head.outputs.current == 'true'");
  });

  it("hands every role the API's digest and one state file for the run", () => {
    for (const name of [
      "Deploy the worker roles (Dokploy)",
      "Deploy the edge roles (Dokploy)",
      "Move the tags of the roles not deployed",
      "Put the tags back after a failed deploy",
    ]) {
      const { text } = stepOf(deploy, name);

      expect(text, name).toContain(
        "STATE_FILE: ${{ runner.temp }}/deploy-roles.state",
      );
    }

    expect(stepOf(deploy, "Deploy the worker roles (Dokploy)").text).toContain(
      "API_DIGEST: ${{ inputs.api-digest }}",
    );
  });

  it("puts a failed role's tag back where the API's would go back", () => {
    const box = sandbox();

    try {
      box.stub("docker", "exit 0");
      const file = `${box.root}/deploy-roles.state`;

      writeFileSync(file, `worker failed ${digest("0")}\n`);

      const result = runBlock(
        box,
        stepOf(deploy, "Put the tags back after a failed deploy").run,
        {
          TAG: "staging",
          RESTORE_API: "true",
          PREVIOUS_API: digest("1"),
          PREVIOUS_AI: digest("a"),
          API_DEPLOY: "skipped",
          AI_DEPLOY: "success",
          STATE_FILE: file,
        },
        process.cwd(),
      );

      expect(result.status, result.stderr).toBe(0);
      expect(box.calls("docker")).toEqual([
        `docker buildx imagetools create --tag ${REPO}:staging-worker ${REPO}@${digest("0")}`,
      ]);
    } finally {
      box.dispose();
    }
  });

  it("gets each role's Application id from both environments' secrets", () => {
    for (const [workflow, job] of [
      ["staging.yml", "deploy-staging"],
      ["production.yml", "promote-production"],
    ] as const) {
      const { text } = jobOf(readWorkflow(workflow), job);

      for (const role of ROLES) {
        const input = `dokploy-${role}-application-id`;
        const secret = `DOKPLOY_${role.toUpperCase().replace("-", "_")}_APPLICATION_ID`;

        expect(text, `${workflow} ${input}`).toContain(
          `${input}: \${{ secrets.${secret} }}`,
        );
        expect(deploy.text).toContain(`  ${input}:`);
      }
    }
  });
});
