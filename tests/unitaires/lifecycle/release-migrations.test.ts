import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  hasShell,
  repoFile,
  run,
  sandbox,
  type Sandbox,
} from "./support/shell-harness";

/**
 * Migrations as ONE release step, before the rollout — not at the boot of
 * every replica.
 *
 * At boot, a migration that failed or ran past the liveness budget left a row
 * with `finished_at` NULL in `_prisma_migrations`, and from then on every
 * `migrate deploy` of every image version — the old one included — refused to
 * run (P3009). The next restart of any replica was an outage until someone
 * resolved it by hand. Now the staging deploy and the promote run the step
 * on the Dokploy Application trajetto-api-migrate (the release image, on the
 * environment's tag) and wait for its outcome (dokploy-release.mjs, tested
 * in dokploy-release.test.ts): a failing migration fails one step, no tag of
 * the API or the AI moves and the running replicas never notice. The API
 * image cannot migrate at all: it carries no Prisma CLI.
 *
 * And only when needed: the step runs when the environment's database has
 * not applied this release image yet (`<env>-applied`, moved only after a
 * step that finished). A push that changes no migration reuses the release
 * image (migrate-source.sh) and runs nothing.
 */
const bash = hasShell("bash");

const workflow = readFileSync(
  repoFile(".github/workflows/deploy.yml"),
  "utf8",
).replace(/\r\n/g, "\n");

function stepsOf(name: string) {
  const start = workflow.indexOf(`\n  ${name}:`);
  const end = workflow.indexOf("\n  # ──", start + 1);
  const job = workflow.slice(start, end === -1 ? undefined : end);
  const steps = job.split(/\n {6}- name: /).slice(1);
  const index = (step: string) =>
    steps.findIndex((each) => each.startsWith(step));
  const text = (step: string) => {
    const at = index(step);

    expect(at, step).toBeGreaterThan(-1);

    return steps[at];
  };

  return { steps, index, text };
}

/** A step's `run: |` block, dedented. */
function runBlock(stepText: string): string {
  const lines = stepText.split("\n");
  const at = lines.findIndex((line) => /^\s+run: \|$/.test(line));
  const indent = lines[at].search(/\S/) + 2;
  const body: string[] = [];

  for (const line of lines.slice(at + 1)) {
    if (line.trim() !== "" && line.search(/\S/) < indent) break;
    body.push(line.slice(indent));
  }

  return body.join("\n");
}

const DECIDE = "Do the migrations need to run?";

const JOBS = [
  {
    job: "deploy-staging",
    configured: "Is the staging deploy configured?",
    move: "Move the release image's staging tag to this build",
    release: "Run the database migrations on staging (Dokploy)",
    record: "Record the migrations as applied on staging",
    tag: "staging",
    later: [
      "Move the AI's staging tag to this build",
      "Deploy the AI service to staging (Dokploy)",
      "Move staging to this build",
      "Deploy to staging (Dokploy)",
    ],
  },
  {
    job: "promote-production",
    configured: "Is the production deploy configured?",
    move: "Move the release image's stable tag to this build",
    release: "Run the database migrations on production (Dokploy)",
    record: "Record the migrations as applied on production",
    tag: "stable",
    later: [
      "Promote image to stable",
      "Promote the AI image to stable",
      "Deploy the AI service to production (Dokploy)",
      "Deploy to production (Dokploy)",
    ],
  },
];

describe("the deploy workflows", () => {
  it.each(JOBS)(
    "$job decides, moves the tag, migrates and records it, in that order, before any service moves",
    ({ job, configured, move, release, record, later }) => {
      const { index } = stepsOf(job);
      const order = [configured, DECIDE, move, release, record].map(index);

      for (const at of order) expect(at).toBeGreaterThan(-1);
      expect([...order].sort((a, b) => a - b)).toEqual(order);

      for (const step of later) {
        expect(index(step), step).toBeGreaterThan(order[order.length - 1]);
      }
    },
  );

  it.each(JOBS)(
    "$job runs the step through the release Application on `:$tag`, never with a database credential",
    ({ job, release, tag }) => {
      const step = stepsOf(job).text(release);

      expect(step).toContain(
        "DOKPLOY_APPLICATION_ID: ${{ secrets.DOKPLOY_MIGRATE_APPLICATION_ID }}",
      );
      expect(step).toContain(
        `RELEASE_IMAGE: ghcr.io/trajetto-organization/trajetto-api-migrate:${tag}\n`,
      );
      expect(step).toContain("run: node .github/scripts/dokploy-release.mjs");
      expect(step).not.toMatch(/DATABASE_URL|SSH_/);
    },
  );

  it.each(JOBS)(
    "$job moves `:$tag` before the deploy and `:$tag-applied` only after it, both by digest",
    ({ job, move, record, tag }) => {
      const { text } = stepsOf(job);

      expect(runBlock(text(move))).toMatch(
        new RegExp(
          `ghcr\\.sh tag \\\\\\n\\s+ghcr\\.io/trajetto-organization/trajetto-api-migrate:${tag} \\\\\\n\\s+"ghcr\\.io/trajetto-organization/trajetto-api-migrate@\\$\\{MIGRATE_DIGEST\\}"`,
        ),
      );
      expect(runBlock(text(record))).toMatch(
        new RegExp(
          `ghcr\\.sh tag \\\\\\n\\s+ghcr\\.io/trajetto-organization/trajetto-api-migrate:${tag}-applied \\\\\\n\\s+"ghcr\\.io/trajetto-organization/trajetto-api-migrate@\\$\\{MIGRATE_DIGEST\\}"`,
        ),
      );
    },
  );

  it.each(JOBS)(
    "$job: the decision only when Dokploy deploys, the rest only when it said to run, with no raw input in a script",
    ({ job, move, release, record }) => {
      const { text } = stepsOf(job);

      expect(text(DECIDE)).toContain("steps.dokploy.outputs.enabled == 'true'");
      expect(text(DECIDE)).toContain("        id: migrations\n");

      for (const step of [move, release, record]) {
        expect(text(step), step).toContain(
          "steps.migrations.outputs.run == 'true'",
        );
      }

      for (const step of [DECIDE, move, record]) {
        expect(runBlock(text(step)), step).not.toContain("${{");
      }
    },
  );

  it("staging compares the release image this run built with what its database applied", () => {
    const step = stepsOf("deploy-staging").text(DECIDE);

    expect(step).toContain(
      "MIGRATE_DIGEST: ${{ needs.build-and-push.outputs.migrate_digest }}",
    );
    expect(runBlock(step)).toContain(
      "ghcr.sh digest ghcr.io/trajetto-organization/trajetto-api-migrate:staging-applied",
    );
  });

  it("the promote reads the release image of the build it promotes", () => {
    const { text } = stepsOf("promote-production");

    // The build the staging check settled on (promote-workflow.test.ts).
    expect(text(DECIDE)).toContain("IMAGE_TAG: ${{ steps.staged.outputs.tag }}");
    expect(runBlock(text(DECIDE))).toContain(
      'ghcr.sh digest "ghcr.io/trajetto-organization/trajetto-api-migrate:${IMAGE_TAG}"',
    );

    for (const step of [
      "Move the release image's stable tag to this build",
      "Record the migrations as applied on production",
    ]) {
      expect(text(step), step).toContain(
        "MIGRATE_DIGEST: ${{ steps.migrations.outputs.digest }}",
      );
    }
  });

  it("requires the release Application wherever Dokploy deploys", () => {
    for (const { job, configured } of JOBS) {
      expect(stepsOf(job).text(configured), job).toContain(
        "DOKPLOY_MIGRATE_APPLICATION_ID: ${{ secrets.DOKPLOY_MIGRATE_APPLICATION_ID }}",
      );
    }
  });

  it("has no switch left to keep migrating on boot, and no SSH path to the database", () => {
    // The API image cannot migrate; a variable that pretended otherwise
    // would only mislead. The release step no longer goes over SSH.
    for (const file of [
      ".github/workflows/deploy.yml",
      "Dockerfile",
      "infra/scripts/docker-entrypoint.sh",
    ]) {
      const text = readFileSync(repoFile(file), "utf8");

      expect(text, file).not.toContain("MIGRATIONS_VIA_JOB");
      expect(text, file).not.toContain("RUN_MIGRATIONS_ON_BOOT");
      expect(text, file).not.toContain("release-migrations.sh");
    }

    expect(workflow).not.toContain("secrets.DEPLOY_SSH_KEY }}");
  });
});

let box: Sandbox;

beforeEach(() => {
  box = sandbox();
});

afterEach(() => box.dispose());

/**
 * Runs a decision step with ghcr.sh stubbed under .github/scripts: a ref
 * ending in `-applied` answers STUB_APPLIED, any other STUB_DIGEST.
 */
function decide(job: string, env: Record<string, string>) {
  box.file(
    ".github/scripts/ghcr.sh",
    [
      'case "$2" in',
      '  *-applied) printf "%s" "${STUB_APPLIED:-}" ;;',
      '  *) printf "%s" "${STUB_DIGEST:-}" ;;',
      "esac",
    ].join("\n"),
  );

  const output = `${box.root}/output`;
  const summary = `${box.root}/summary`;
  const script = box.file(
    "step.sh",
    `set -eo pipefail\n${runBlock(stepsOf(job).text(DECIDE))}`,
  );
  const result = run("bash", script, [], {
    cwd: box.root,
    env: { GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, ...env },
  });
  const outputs = Object.fromEntries(
    readFileSync(output, { encoding: "utf8", flag: "a+" })
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("=") as [string, string]),
  );

  return { ...result, log: result.stdout + result.stderr, outputs };
}

const DIGEST = `sha256:${"a".repeat(64)}`;
const OLDER = `sha256:${"b".repeat(64)}`;

describe.skipIf(!bash)("the staging decision, run", () => {
  it("runs the step for a release image the database has not applied", () => {
    const result = decide("deploy-staging", {
      MIGRATE_DIGEST: DIGEST,
      STUB_APPLIED: OLDER,
    });

    expect(result.status, result.log).toBe(0);
    expect(result.outputs).toEqual({ run: "true" });
  });

  it("runs it on a database that never applied one (the first deploy)", () => {
    const result = decide("deploy-staging", { MIGRATE_DIGEST: DIGEST });

    expect(result.status, result.log).toBe(0);
    expect(result.outputs).toEqual({ run: "true" });
  });

  it("skips it, saying so, when the database applied this very image", () => {
    const result = decide("deploy-staging", {
      MIGRATE_DIGEST: DIGEST,
      STUB_APPLIED: DIGEST,
    });

    expect(result.status, result.log).toBe(0);
    expect(result.outputs).toEqual({ run: "false" });
    expect(result.log).toContain("::notice::Migrations: o banco de staging já aplicou");
  });
});

/**
 * The promote's decision, run: git real, in a repository with one commit
 * from before the release image (no infra/scripts/schema-guard.ts) and one
 * from after it. A build with no release image is skipped only when it
 * provably predates it; any other lost its push, and the step fails before
 * `stable` moves.
 */
describe.skipIf(!bash)("the promote's decision, run", () => {
  let before = "";
  let after = "";

  beforeEach(() => {
    // A throwaway repository: no global identity or signing needed.
    box.file(
      "tests-git.sh",
      'exec git -c user.name=t -c user.email=t@example.invalid -c commit.gpgsign=false "$@"\n',
    );
    const g = (...args: string[]) =>
      run("bash", `${box.root}/tests-git.sh`, args, {
        cwd: box.root,
      }).stdout.trim();

    g("init", "-q");
    box.file("README", "x");
    g("add", "README");
    g("commit", "-q", "-m", "before the release image");
    before = g("rev-parse", "HEAD");
    box.file("infra/scripts/schema-guard.ts", "// the guard");
    g("add", "infra/scripts/schema-guard.ts");
    g("commit", "-q", "-m", "the release image");
    after = g("rev-parse", "HEAD");
  });

  const promote = (
    tag: string,
    event: string,
    stubs: { digest?: string; applied?: string } = {},
  ) =>
    decide("promote-production", {
      IMAGE_TAG: tag,
      EVENT: event,
      STUB_DIGEST: stubs.digest ?? "",
      STUB_APPLIED: stubs.applied ?? "",
    });

  it("runs the step with the release image of the build, by digest, when production has not applied it", () => {
    const result = promote(`sha-${after.slice(0, 7)}`, "push", {
      digest: DIGEST,
      applied: OLDER,
    });

    expect(result.status, result.log).toBe(0);
    expect(result.outputs).toEqual({ digest: DIGEST, run: "true" });
  });

  it("skips it when production applied that very image", () => {
    const result = promote(`sha-${after.slice(0, 7)}`, "push", {
      digest: DIGEST,
      applied: DIGEST,
    });

    expect(result.status, result.log).toBe(0);
    expect(result.outputs).toEqual({ digest: DIGEST, run: "false" });
    expect(result.log).toContain("o banco de produção já aplicou");
  });

  it("runs it for a rollback to an older release image too", () => {
    const result = promote(`sha-${after.slice(0, 7)}`, "workflow_dispatch", {
      digest: OLDER,
      applied: DIGEST,
    });

    expect(result.status, result.log).toBe(0);
    expect(result.outputs.run).toBe("true");
  });

  it("fails a merge whose build has no release image: its push failed", () => {
    const result = promote(`sha-${after.slice(0, 7)}`, "push");

    expect(result.status).toBe(1);
    expect(result.log).toContain("o push dela falhou");
    expect(result.outputs).toEqual({});
  });

  it("fails a rollback to a build from after the release image that has none", () => {
    const result = promote(`sha-${after.slice(0, 7)}`, "workflow_dispatch");

    expect(result.status).toBe(1);
    expect(result.outputs).toEqual({});
  });

  it("skips, with a notice, a rollback to a build from before the release image", () => {
    const result = promote(`sha-${before.slice(0, 7)}`, "workflow_dispatch");

    expect(result.status, result.log).toBe(0);
    expect(result.log).toContain("anterior à imagem de migração");
    expect(result.outputs).toEqual({ run: "false" });
  });

  it("skips the main-<sha> builds, all from before the staging branch", () => {
    const result = promote("main-0a1b2c3", "workflow_dispatch");

    expect(result.status, result.log).toBe(0);
    expect(result.outputs).toEqual({ run: "false" });
  });

  it("fails closed on a commit it cannot find", () => {
    const result = promote("sha-ffffff0", "workflow_dispatch");

    expect(result.status).toBe(1);
  });
});
