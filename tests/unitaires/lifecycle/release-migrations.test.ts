import { readFileSync } from "node:fs";

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
  allActions,
  allWorkflows,
  conditionOf,
  jobOf,
  readAction,
  readWorkflow,
  stepNames,
  stepOf,
  type Job,
} from "./support/workflow-text";

/**
 * Migrations as ONE release step, before the rollout — not at the boot of
 * every replica.
 *
 * At boot, a migration that failed or ran past the liveness budget left a row
 * with `finished_at` NULL in `_prisma_migrations`, and from then on every
 * `migrate deploy` of every image version — the old one included — refused to
 * run (P3009). The next restart of any replica was an outage until someone
 * resolved it by hand. Now the deploy of each environment
 * (.github/actions/deploy, for staging and production) runs the step on the
 * Dokploy Application trajetto-api-migrate (the release image, on the
 * environment's tag) and waits for its outcome (dokploy-release.mjs, tested
 * in dokploy-release.test.ts): a failing migration fails one step, no tag of
 * the API or the AI moves and the running replicas never notice. The API
 * image cannot migrate at all: it carries no Prisma CLI.
 *
 * And only when needed: the step runs when the environment's database has
 * not applied this release image yet (`<tag>-applied`, moved only after a
 * step that finished). A push that changes no migration reuses the release
 * image (migrate-source.sh) and runs nothing.
 */
const bash = hasShell("bash");

const deploy = readAction("deploy");
const staging = readWorkflow("staging.yml");
const production = readWorkflow("production.yml");
const evidence = jobOf(production, "evidence");

const DECIDE = "Decide migrations";
const SETTINGS = "Check deploy settings";
const MOVE = "Move the release image tag to this build";
const RELEASE = "Run the database migrations (Dokploy)";
const RECORD = "Record the migrations as applied";
const LATER = [
  "Move the AI tag to this build",
  "Deploy the AI service (Dokploy)",
  "Move the API tag to this build",
  "Deploy the API (Dokploy)",
];

/** The `with:` value a deploy job hands the action. */
const input = (job: Job, key: string) =>
  new RegExp(`\\n {10}${key}: (.+)\\n`).exec(`${job.text}\n`)?.[1];

describe("the deploy action", () => {
  it("decides, moves the tag, migrates and records it, in that order, before any service moves", () => {
    const names = stepNames(deploy);
    const order = [SETTINGS, DECIDE, MOVE, RELEASE, RECORD].map((name) =>
      names.indexOf(name),
    );

    for (const at of order) expect(at).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    for (const step of LATER) {
      expect(names.indexOf(step), step).toBeGreaterThan(
        order[order.length - 1],
      );
    }
  });

  it("runs the step through the release Application on the environment's tag, never with a database credential", () => {
    const step = stepOf(deploy, RELEASE).text;

    expect(step).toContain(
      "DOKPLOY_APPLICATION_ID: ${{ inputs.dokploy-migrate-application-id }}",
    );
    expect(step).toContain(
      "RELEASE_IMAGE: ghcr.io/trajetto-organization/trajetto-api-migrate:${{ inputs.tag }}\n",
    );
    expect(step).toContain("run: node .github/scripts/dokploy-release.mjs");
    expect(step).not.toMatch(/DATABASE_URL|SSH_/);
    expect(input(jobOf(staging, "deploy-staging"), "tag")).toBe("staging");
    expect(input(jobOf(production, "promote-production"), "tag")).toBe(
      "stable",
    );
  });

  // F2-01: a release whose prisma/concurrent builds a big index needs
  // more than 30 min; the patience is the environment's variable, empty
  // being the default (dokploy-release.mjs).
  it("waits for the step as long as the environment's RELEASE_TIMEOUT_SECONDS says", () => {
    expect(stepOf(deploy, RELEASE).text).toContain(
      "RELEASE_TIMEOUT_SECONDS: ${{ inputs.release-timeout-seconds }}\n",
    );
    for (const job of [
      jobOf(staging, "deploy-staging"),
      jobOf(production, "promote-production"),
    ]) {
      expect(input(job, "release-timeout-seconds"), job.name).toBe(
        "${{ vars.RELEASE_TIMEOUT_SECONDS }}",
      );
    }
  });

  it("moves `:<tag>` before the deploy and `:<tag>-applied` only after it, both by digest", () => {
    expect(stepOf(deploy, MOVE).run).toMatch(
      /ghcr\.sh tag \\\n\s+"ghcr\.io\/trajetto-organization\/trajetto-api-migrate:\$\{TAG\}" \\\n\s+"ghcr\.io\/trajetto-organization\/trajetto-api-migrate@\$\{MIGRATE_DIGEST\}"/,
    );
    expect(stepOf(deploy, RECORD).run).toMatch(
      /ghcr\.sh tag \\\n\s+"ghcr\.io\/trajetto-organization\/trajetto-api-migrate:\$\{TAG\}-applied" \\\n\s+"ghcr\.io\/trajetto-organization\/trajetto-api-migrate@\$\{MIGRATE_DIGEST\}"/,
    );
  });

  it("decides only when Dokploy deploys, runs the rest only when it said to, with no raw input in a script", () => {
    expect(conditionOf(stepOf(deploy, DECIDE))).toContain(
      "steps.dokploy.outputs.enabled == 'true'",
    );
    expect(stepOf(deploy, DECIDE).text).toContain("      id: migrations\n");

    for (const name of [MOVE, RELEASE, RECORD]) {
      expect(conditionOf(stepOf(deploy, name)), name).toContain(
        "steps.migrations.outputs.run == 'true'",
      );
    }

    for (const name of [DECIDE, MOVE, RECORD]) {
      expect(stepOf(deploy, name).run, name).not.toContain("${{");
    }
  });

  it("gets the release image of the build it deploys: staging's from the Build, production's from the evidence", () => {
    expect(input(jobOf(staging, "deploy-staging"), "migrate-digest")).toBe(
      "${{ needs.build.outputs.migrate_digest }}",
    );
    expect(
      input(jobOf(production, "promote-production"), "migrate-digest"),
    ).toBe("${{ needs.evidence.outputs.migrate_digest }}");
    expect(
      input(jobOf(production, "promote-production"), "migrate-presplit"),
    ).toBe("${{ needs.evidence.outputs.migrate_presplit }}");
    expect(input(jobOf(staging, "deploy-staging"), "migrate-presplit")).toBe(
      undefined,
    );
  });

  it("requires the release Application wherever Dokploy deploys", () => {
    expect(stepOf(deploy, SETTINGS).text).toContain(
      "DOKPLOY_MIGRATE_APPLICATION_ID: ${{ inputs.dokploy-migrate-application-id }}",
    );
    for (const job of [
      jobOf(staging, "deploy-staging"),
      jobOf(production, "promote-production"),
    ]) {
      expect(input(job, "dokploy-migrate-application-id"), job.name).toBe(
        "${{ secrets.DOKPLOY_MIGRATE_APPLICATION_ID }}",
      );
    }
  });

  it("has no switch left to keep migrating on boot, and no SSH path to the database", () => {
    // The API image cannot migrate; a variable that pretended otherwise
    // would only mislead. The release step no longer goes over SSH.
    const texts = [
      ...allWorkflows().map((each) => [each.file, each.text] as const),
      ...allActions().map((each) => [each.file, each.text] as const),
      ...["Dockerfile", "infra/scripts/docker-entrypoint.sh"].map(
        (file) => [file, readFileSync(repoFile(file), "utf8")] as const,
      ),
    ];

    for (const [file, text] of texts) {
      expect(text, file).not.toContain("MIGRATIONS_VIA_JOB");
      expect(text, file).not.toContain("RUN_MIGRATIONS_ON_BOOT");
      expect(text, file).not.toContain("release-migrations.sh");
      expect(text, file).not.toContain("secrets.DEPLOY_SSH_KEY }}");
    }
  });
});

let box: Sandbox;

beforeEach(() => {
  box = sandbox();
});

afterEach(() => box.dispose());

/** ghcr.sh stubbed under .github/scripts: `-applied` answers STUB_APPLIED, any other STUB_DIGEST. */
function stubGhcr() {
  box.file(
    ".github/scripts/ghcr.sh",
    [
      'case "$2" in',
      '  *-applied) printf "%s" "${STUB_APPLIED:-}" ;;',
      '  *) printf "%s" "${STUB_DIGEST:-}" ;;',
      "esac",
    ].join("\n"),
  );
}

const DIGEST = `sha256:${"a".repeat(64)}`;
const OLDER = `sha256:${"b".repeat(64)}`;

describe.skipIf(!bash)("the decision, run", () => {
  const decide = (env: Record<string, string>) => {
    stubGhcr();

    return runBlock(
      box,
      stepOf(deploy, DECIDE).run,
      { ENVIRONMENT: "staging", TAG: "staging", PRESPLIT: "false", ...env },
      box.root,
    );
  };

  it("runs the step for a release image the database has not applied", () => {
    const result = decide({ MIGRATE_DIGEST: DIGEST, STUB_APPLIED: OLDER });

    expect(result.status, result.log).toBe(0);
    expect(result.outputs).toEqual({ run: "true" });
  });

  it("runs it on a database that never applied one (the first deploy)", () => {
    const result = decide({ MIGRATE_DIGEST: DIGEST });

    expect(result.status, result.log).toBe(0);
    expect(result.outputs).toEqual({ run: "true" });
  });

  it("skips it, saying so, when the database applied this very image", () => {
    const staging = decide({ MIGRATE_DIGEST: DIGEST, STUB_APPLIED: DIGEST });

    expect(staging.status, staging.log).toBe(0);
    expect(staging.outputs).toEqual({ run: "false" });
    expect(staging.log).toContain(
      "::notice::Migrations: o banco de staging já aplicou",
    );

    const production = decide({
      ENVIRONMENT: "production",
      TAG: "stable",
      MIGRATE_DIGEST: DIGEST,
      STUB_APPLIED: DIGEST,
    });

    expect(production.outputs).toEqual({ run: "false" });
    expect(production.log).toContain("o banco de produção já aplicou");
  });

  it("compares with the environment's own `-applied` tag", () => {
    box.file(
      ".github/scripts/ghcr.sh",
      `printf '%s\\n' "$2" >> "${box.root}/read"; printf '%s' "${OLDER}"`,
    );

    const result = runBlock(
      box,
      stepOf(deploy, DECIDE).run,
      {
        ENVIRONMENT: "production",
        TAG: "stable",
        PRESPLIT: "false",
        MIGRATE_DIGEST: DIGEST,
      },
      box.root,
    );

    expect(result.status, result.log).toBe(0);
    expect(readFileSync(`${box.root}/read`, "utf8")).toBe(
      "ghcr.io/trajetto-organization/trajetto-api-migrate:stable-applied\n",
    );
  });

  it("skips it for a build that predates the release image, without asking GHCR", () => {
    const result = decide({
      ENVIRONMENT: "production",
      TAG: "stable",
      PRESPLIT: "true",
      MIGRATE_DIGEST: "",
      STUB_APPLIED: DIGEST,
    });

    expect(result.status, result.log).toBe(0);
    expect(result.outputs).toEqual({ run: "false" });
    expect(result.log).toContain("anterior à imagem de migração");
  });

  it("fails, before anything moves, without a release image it was not told to skip", () => {
    const result = decide({ MIGRATE_DIGEST: "" });

    expect(result.status).toBe(1);
    expect(result.outputs).toEqual({});
    expect(result.log).toContain("::error::Falta o digest da imagem");
  });
});

/**
 * The promote's reading of the release image, run: git real, in a
 * repository with one commit from before the release image (no
 * infra/scripts/schema-guard.ts) and one from after it. A build with no
 * release image is let through only when it provably predates it; any other
 * lost its push, and the evidence fails before the approval.
 */
describe.skipIf(!bash)("the promote's release image, read", () => {
  let before = "";
  let after = "";
  let git: (...args: string[]) => string = () => "";

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
    git = g;

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

  /** ghcr.sh: trajetto-api answers API, trajetto-api-migrate MIGRATE, trajetto-ai AI. */
  const read = (
    tag: string,
    event: string,
    stubs: { migrate?: string; ai?: string; postgres?: string } = {},
  ) => {
    box.file(
      ".github/scripts/ghcr.sh",
      [
        'case "$2" in',
        '  *trajetto-api-migrate:*) printf "%s" "${STUB_MIGRATE:-}" ;;',
        '  *trajetto-api:*) printf "%s" "${STUB_API:-}" ;;',
        '  *trajetto-ai:*) printf "%s" "${STUB_AI:-}" ;;',
        '  *trajetto-postgres:src-*) [ "${2##*:src-}" = "${STUB_POSTGRES_TREE:-none}" ] && printf "%s" "${STUB_POSTGRES:-}" ;;',
        "esac",
      ].join("\n"),
    );

    return runBlock(
      box,
      stepOf(evidence, "Read the digests to promote").run,
      {
        IMAGE_TAG: tag,
        EVENT: event,
        STUB_API: `sha256:${"1".repeat(64)}`,
        STUB_MIGRATE: stubs.migrate ?? "",
        STUB_AI: stubs.ai ?? "",
        STUB_POSTGRES: stubs.postgres ?? "",
        STUB_POSTGRES_TREE: stubs.postgres
          ? git("rev-parse", `${tag.slice(4)}:infra/postgres`)
          : "none",
      },
      box.root,
    );
  };

  it("reads the digests of the build, the commit the public check waits for included", () => {
    const result = read(`sha-${after.slice(0, 7)}`, "push", {
      migrate: DIGEST,
      ai: OLDER,
    });

    expect(result.status, result.log).toBe(0);
    expect(result.outputs).toEqual({
      api: `sha256:${"1".repeat(64)}`,
      migrate: DIGEST,
      presplit: "false",
      ai: OLDER,
      postgres: "",
      expected: after.slice(0, 7),
    });
  });

  // The Database's image of the promoted commit, by its infra/postgres:
  // only what trajetto-postgres:stable moves to, as a reference.
  it("reads the Database's image of the same infra/postgres, for the reference tag", () => {
    box.file("infra/postgres/Dockerfile", "FROM postgres");
    git("add", "infra/postgres/Dockerfile");
    git("commit", "-q", "-m", "the database image");
    const head = git("rev-parse", "HEAD");
    const POSTGRES = `sha256:${"7".repeat(64)}`;

    const result = read(`sha-${head.slice(0, 7)}`, "push", {
      migrate: DIGEST,
      postgres: POSTGRES,
    });

    expect(result.status, result.log).toBe(0);
    expect(result.outputs.postgres).toBe(POSTGRES);
    expect(result.summary).toContain(`trajetto-postgres@${POSTGRES}`);

    // GHCR not answering about a reference never holds the promote.
    box.file(
      ".github/scripts/ghcr.sh",
      'case "$2" in *trajetto-postgres:*) exit 1 ;; *trajetto-api-migrate:*) printf "%s" "$STUB_MIGRATE" ;; *trajetto-api:*) printf "%s" "$STUB_API" ;; esac\n',
    );
    const silent = runBlock(
      box,
      stepOf(evidence, "Read the digests to promote").run,
      {
        IMAGE_TAG: `sha-${head.slice(0, 7)}`,
        EVENT: "push",
        STUB_API: `sha256:${"1".repeat(64)}`,
        STUB_MIGRATE: DIGEST,
      },
      box.root,
    );

    expect(silent.status, silent.log).toBe(0);
    expect(silent.outputs.postgres).toBe("");
    expect(silent.log).toContain(
      "::warning::O GHCR não respondeu sobre trajetto-postgres",
    );
  });

  it("fails a merge whose build has no release image: its push failed", () => {
    const result = read(`sha-${after.slice(0, 7)}`, "push");

    expect(result.status).toBe(1);
    expect(result.log).toContain("o push dela falhou");
    expect(result.outputs).toEqual({});
  });

  it("fails a rollback to a build from after the release image that has none", () => {
    const result = read(`sha-${after.slice(0, 7)}`, "workflow_dispatch");

    expect(result.status).toBe(1);
    expect(result.outputs).toEqual({});
  });

  it("lets a rollback to a build from before the release image through, flagged, with a notice", () => {
    const result = read(`sha-${before.slice(0, 7)}`, "workflow_dispatch");

    expect(result.status, result.log).toBe(0);
    expect(result.log).toContain("anterior à imagem de migração");
    expect(result.outputs.presplit).toBe("true");
    expect(result.outputs.migrate).toBe("");
  });

  it("lets the main-<sha> builds through, all from before the staging branch", () => {
    const result = read("main-0a1b2c3", "workflow_dispatch");

    expect(result.status, result.log).toBe(0);
    expect(result.outputs.presplit).toBe("true");
    expect(result.outputs.expected).toBe("0a1b2c3");
  });

  it("fails closed on a commit it cannot find", () => {
    const result = read("sha-ffffff0", "workflow_dispatch");

    expect(result.status).toBe(1);
  });

  it("leaves the AI where it is for a build older than the service", () => {
    const result = read(`sha-${after.slice(0, 7)}`, "push", {
      migrate: DIGEST,
    });

    expect(result.status, result.log).toBe(0);
    expect(result.outputs.ai).toBe("");
  });
});

/**
 * The release step runs again with the same image (plano-escala U-11,
 * D19): with force_release, or when the last run left a step of infra/sql
 * or prisma/post-deploy pending or failed — read in /health/rollout with
 * the environment's ROLLOUT_STATUS_TOKEN (rollout-pending.mjs, stubbed
 * here; run for real in rollout-pending.test.ts). Without the token, or
 * when the API cannot tell, today's rule, with a warning.
 */
describe.skipIf(!bash)("running the step again with the same image", () => {
  /** rollout-pending.mjs stubbed: prints STUB_PENDING, or fails. */
  function stubPending() {
    box.file(
      ".github/scripts/rollout-pending.mjs",
      [
        'import { appendFileSync } from "node:fs";',
        'appendFileSync("asked", "x");',
        "if (process.env.STUB_PENDING_FAIL) { console.error(process.env.STUB_PENDING_FAIL); process.exit(1); }",
        'process.stdout.write(process.env.STUB_PENDING ?? "");',
      ].join("\n"),
    );
  }

  const decide = (env: Record<string, string>) => {
    stubGhcr();
    stubPending();

    return runBlock(
      box,
      stepOf(deploy, DECIDE).run,
      {
        ENVIRONMENT: "staging",
        TAG: "staging",
        PRESPLIT: "false",
        MIGRATE_DIGEST: DIGEST,
        STUB_APPLIED: DIGEST,
        FORCE_RELEASE: "false",
        ROLLOUT_STATUS_TOKEN: "",
        API_URL: "https://api.example.com",
        ...env,
      },
      box.root,
    );
  };

  const asked = () => {
    try {
      return readFileSync(`${box.root}/asked`, "utf8").length;
    } catch {
      return 0;
    }
  };

  it("runs it with force_release, without asking the API", () => {
    const result = decide({ FORCE_RELEASE: "true", ROLLOUT_STATUS_TOKEN: "t" });

    expect(result.status, result.log).toBe(0);
    expect(result.outputs).toEqual({ run: "true" });
    expect(result.log).toContain("::notice::Migrations: force_release");
    expect(result.summary).toContain("forçada");
    expect(asked()).toBe(0);
  });

  it("runs it when the last release left a step pending, even with the image it applied", () => {
    const result = decide({
      ROLLOUT_STATUS_TOKEN: "t",
      STUB_PENDING: "prisma/post-deploy/10-swap.sql",
    });

    expect(result.status, result.log).toBe(0);
    expect(result.outputs).toEqual({ run: "true" });
    expect(result.log).toContain(
      "deixou passos pendentes (prisma/post-deploy/10-swap.sql)",
    );
    expect(result.summary).toContain("prisma/post-deploy/10-swap.sql");
  });

  it("skips it when nothing is pending", () => {
    const result = decide({ ROLLOUT_STATUS_TOKEN: "t", STUB_PENDING: "" });

    expect(result.status, result.log).toBe(0);
    expect(result.outputs).toEqual({ run: "false" });
    expect(asked()).toBe(1);
    expect(result.log).not.toContain("::warning::");
  });

  it("keeps today's rule, with a warning, without the token", () => {
    const result = decide({ STUB_PENDING: "prisma/post-deploy/10-swap.sql" });

    expect(result.status, result.log).toBe(0);
    expect(result.outputs).toEqual({ run: "false" });
    expect(result.log).toContain(
      "::warning::Sem o secret ROLLOUT_STATUS_TOKEN no environment staging",
    );
    expect(asked()).toBe(0);
  });

  it("keeps today's rule, with the reason, when the API cannot tell", () => {
    const result = decide({
      ROLLOUT_STATUS_TOKEN: "t",
      STUB_PENDING_FAIL: "respondeu 404: a API ainda não tem a rota",
    });

    expect(result.status, result.log).toBe(0);
    expect(result.outputs).toEqual({ run: "false" });
    expect(result.log).toContain(
      "::warning::Não deu para ler os passos pendentes de staging (respondeu 404: a API ainda não tem a rota",
    );
  });

  it("never asks the API when the image is new: it runs anyway", () => {
    const result = decide({
      ROLLOUT_STATUS_TOKEN: "t",
      STUB_APPLIED: OLDER,
    });

    expect(result.outputs).toEqual({ run: "true" });
    expect(asked()).toBe(0);
  });

  it("ignores force_release, saying so, for a build without a release image", () => {
    const result = decide({
      PRESPLIT: "true",
      MIGRATE_DIGEST: "",
      FORCE_RELEASE: "true",
    });

    expect(result.status, result.log).toBe(0);
    expect(result.outputs).toEqual({ run: "false" });
    expect(result.log).toContain("::warning::force_release ignorado");
  });
});

describe("force_release and the pending steps, wired", () => {
  it("is a Run workflow input of staging and production, handed to the action", () => {
    for (const workflow of [staging, production]) {
      expect(workflow.text).toMatch(
        /\n {6}force_release:\n {8}description: .+\n {8}type: boolean\n/,
      );
    }

    for (const job of [
      jobOf(staging, "deploy-staging"),
      jobOf(production, "promote-production"),
    ]) {
      expect(input(job, "force-release"), job.name).toBe(
        "${{ inputs.force_release == true }}",
      );
      expect(input(job, "rollout-status-token"), job.name).toBe(
        "${{ secrets.ROLLOUT_STATUS_TOKEN }}",
      );
      expect(
        input(job, "release-serialize-with-application-id"),
        job.name,
      ).toBe("${{ vars.RELEASE_SERIALIZE_WITH_APPLICATION_ID }}");
    }
  });

  it("reaches the decision and the release step through env, never inline", () => {
    const decideStep = stepOf(deploy, DECIDE).text;

    expect(decideStep).toContain("FORCE_RELEASE: ${{ inputs.force-release }}");
    expect(decideStep).toContain(
      "ROLLOUT_STATUS_TOKEN: ${{ inputs.rollout-status-token }}",
    );
    expect(decideStep).toContain("API_URL: ${{ inputs.api-public-url }}");
    expect(stepOf(deploy, RELEASE).text).toContain(
      "RELEASE_SERIALIZE_WITH_APPLICATION_ID: ${{ inputs.release-serialize-with-application-id }}",
    );
  });
});
