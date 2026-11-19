import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runBlock } from "./support/run-block";
import { hasShell, sandbox, type Sandbox } from "./support/shell-harness";
import {
  conditionOf,
  jobOf,
  readAction,
  readWorkflow,
  stepNames,
  stepOf,
  timeoutOf,
  type Job,
} from "./support/workflow-text";

/**
 * The road to production: build once on staging, promote by digest.
 *
 * Every push to `staging` validates and builds the images ONCE, as the
 * immutable `sha-<sha>` (staging.yml); the merge into `main` promotes the
 * exact build staging ran for the merged commit, never a rebuild
 * (production.yml); the manual button is the rollback path, so it must ship
 * exactly the build it is given — and nothing else. The pull request into
 * main (pr.yml) proves, before the merge, that there is such a build.
 *
 * History: `image_tag` defaulted to `latest`, which is whatever was built
 * last: a promote "of the validated build" shipped any merge that landed
 * after it. The value was interpolated straight into `run:`
 * (`${{ inputs.image_tag }}`), a shell injection for anyone allowed to press
 * the button. And the deployment fell back to `latest` too, so rolling back only
 * worked once someone had remembered to set a variable in the orchestrator.
 */
const read = (...parts: string[]) =>
  readFileSync(resolve(process.cwd(), ...parts), "utf8").replace(/\r\n/g, "\n");

const staging = readWorkflow("staging.yml");
const production = readWorkflow("production.yml");
const pr = readWorkflow("pr.yml");
const validate = readWorkflow("validate.yml");
const deploy = readAction("deploy");

const evidence = jobOf(production, "evidence");
const promote = jobOf(production, "promote-production");
const deployStaging = jobOf(staging, "deploy-staging");

const index = (name: string) => stepNames(evidence).indexOf(name);
const at = (name: string) => stepNames(deploy).indexOf(name);

/** The `with:` value a deploy job hands the action. */
const input = (job: Job, key: string) =>
  new RegExp(`\\n {10}${key}: (.+)\\n`).exec(`${job.text}\n`)?.[1];

/** The workflow's `on:` block. */
const triggers = (text: string) =>
  text.slice(text.indexOf("\non:"), text.indexOf("\npermissions:"));

describe("the workflows' triggers", () => {
  it("staging runs on its pushes and by hand, production on main's and by hand, the PR check on pull requests into main", () => {
    expect(triggers(staging.text)).toMatch(/push:\n {4}branches: \[staging\]/);
    expect(triggers(staging.text)).toContain("workflow_dispatch:");
    expect(triggers(production.text)).toMatch(/push:\n {4}branches: \[main\]/);
    expect(triggers(production.text)).toContain("workflow_dispatch:");
    expect(triggers(pr.text)).toMatch(/pull_request:\n {4}branches: \[main\]/);
    expect(triggers(pr.text)).not.toMatch(/push:|workflow_dispatch:/);
  });

  it("asks for nothing beyond reading the repository unless a job needs it", () => {
    for (const workflow of [staging, production, pr, validate]) {
      expect(workflow.text, workflow.file).toMatch(
        /\npermissions:\n {2}contents: read\n/,
      );
    }

    for (const job of validate.jobs) {
      expect(job.text, job.name).not.toContain("packages: write");
    }
    for (const name of ["changes", "secrets", "gate", "image-scan"]) {
      expect(jobOf(staging, name).text, name).not.toContain("packages: write");
    }
    expect(evidence.text).not.toContain("packages: write");
    expect(jobOf(pr, "evidence").text).not.toContain("packages: write");
  });
});

describe("the build (once, on staging)", () => {
  // Run workflow takes any branch: on main the same button is the promote,
  // never a build, and on a work branch nothing at all.
  it("runs only on staging, after the Gate and the secret scan", () => {
    const build = jobOf(staging, "build");

    expect(build.text).toContain("needs: [changes, gate, secrets]");
    expect(build.text).toContain(
      "\n    if: ${{ !cancelled() && github.ref == 'refs/heads/staging' && needs.gate.result == 'success' && needs.secrets.result == 'success' && needs.changes.outputs.docs != 'true' }}\n",
    );
    expect(jobOf(staging, "deploy-staging").text).toContain(
      "\n    if: ${{ !cancelled() && github.ref == 'refs/heads/staging' && needs.build.result == 'success' && needs.image-scan.result == 'success' }}\n",
    );
    expect(evidence.text).toContain("if: github.ref == 'refs/heads/main'");
  });

  it("never happens in the promote or the pull request: production gets the bytes staging ran", () => {
    for (const text of [production.text, pr.text, deploy.text]) {
      expect(text).not.toMatch(/docker\/build-push-action|docker build\s/);
    }
  });

  it("publishes only the immutable sha-<sha>: the mutable tags are moved by digest", () => {
    const build = jobOf(staging, "build").text;
    const metadata = [...build.matchAll(/tags: \|\n((?: {12}.+\n)+)/g)].map(
      (m) => m[1].trim(),
    );

    // The API, its release image (trajetto-api-migrate, which the deploys
    // run before the API rolls out when the database has not applied it)
    // and the AI service (ADR 0010). Database backups are Dokploy's own, so
    // there is no backup image. The release image and the AI also carry
    // `src-<key>`: the hash of what each one is built from
    // (migrate-source.sh; the git hash of infra/ai-ocr), immutable too, and
    // how a later push finds the image to reuse it. The Database's image
    // (trajetto-postgres, plano-escala F1-03) too, built only for a new
    // infra/postgres: its `src-<tree>` and the `sha-<7>` of the commit that
    // built it, and no tag for the commits that reuse it (GHCR's storage
    // is counted).
    expect(metadata).toEqual([
      "type=sha,prefix=sha-",
      "type=sha,prefix=sha-\n            type=raw,value=src-${{ steps.migrate-source.outputs.key }}",
      "type=sha,prefix=sha-\n            type=raw,value=src-${{ steps.ai-source.outputs.tree }}",
      "type=sha,prefix=sha-\n            type=raw,value=src-${{ steps.postgres-source.outputs.tree }}",
      // The PgBouncer's (plano-escala F4-35), reused like the AI's: every
      // commit gets its `sha-<7>` (registry-side, on the reused digest),
      // because the PR check and the promote find it by that name.
      "type=sha,prefix=sha-\n            type=raw,value=src-${{ steps.pgbouncer-source.outputs.tree }}",
    ]);
    expect(build.match(/flavor: latest=false/g)).toHaveLength(5);
    expect(build).not.toContain("Tag the reused Postgres image");
  });

  it("moves trajetto-postgres:stable only as a reference, after production's deploy, never failing it", () => {
    const read = stepOf(evidence, "Read the digests to promote").run;
    const move = stepOf(promote, "Move the Postgres reference tag");

    expect(read).toContain(
      '"ghcr.io/trajetto-organization/trajetto-postgres:src-${tree}"',
    );
    expect(evidence.text).toContain(
      "postgres_digest: ${{ steps.digests.outputs.postgres }}",
    );
    expect(stepNames(promote)).toEqual([
      "Check out the deploy scripts",
      "Deploy to production",
      "Move the Postgres reference tag",
    ]);
    expect(conditionOf(move)).toBe(
      "needs.evidence.outputs.postgres_digest != ''",
    );
    expect(move.run).toContain(
      "ghcr.io/trajetto-organization/trajetto-postgres:stable",
    );
    expect(move.run).toMatch(/else\n\s+echo "::warning::/);
    // Nothing deploys the Database: no Application of it anywhere.
    for (const text of [production.text, staging.text, deploy.text]) {
      expect(text).not.toMatch(/DOKPLOY_(POSTGRES|DATABASE)/);
    }
    expect(deploy.text).not.toContain("trajetto-postgres");
  });

  // The PgBouncer's image (plano-escala F4-35) is promoted like the AI's:
  // the digest staging ran for the commit, read before the approval, and
  // rolled out by the deploy only when production runs another one.
  it("promotes the PgBouncer's image staging ran, through the deploy", () => {
    expect(evidence.text).toContain(
      "pgbouncer_digest: ${{ steps.digests.outputs.pgbouncer }}",
    );
    expect(promote.text).toContain(
      "pgbouncer-digest: ${{ needs.evidence.outputs.pgbouncer_digest }}",
    );
    // The PR check and the promote require its staged-<7> too.
    expect(readFileSync(".github/scripts/staged-build.sh", "utf8")).toContain(
      "IMAGES=${STAGED_IMAGES:-trajetto-api trajetto-ai trajetto-pgbouncer}",
    );
  });
});

describe("the tag given to the promote", () => {
  const dispatch = production.text.slice(
    production.text.indexOf("  workflow_dispatch:"),
    production.text.indexOf("\npermissions:"),
  );

  it("is required and has no default: whoever presses the button names the build", () => {
    expect(dispatch).toMatch(
      /image_tag:\n\s+description: .+\n\s+required: true\n/,
    );
    expect(dispatch).not.toMatch(/default:/);
  });

  it("is resolved, then validated first, before anything is read, migrated, retagged or deployed", () => {
    expect(index("Resolve the build to promote"), "passo de resolução").toBe(0);
    expect(index("Validate the tag to promote"), "passo de validação").toBe(1);
    // The deploy is another job, after this one and its approval.
    expect(promote.text).toContain("needs: evidence");
  });

  it("accepts only an immutable build", () => {
    const pattern = stepOf(evidence, "Validate the tag to promote").run.match(
      /grep -Eq '([^']+)'/,
    )?.[1];

    expect(pattern, "padrão do grep no passo de validação").toBeTruthy();

    const accepts = (tag: string) => new RegExp(pattern!).test(tag);

    expect(accepts("sha-0a1b2c3")).toBe(true);
    expect(accepts("sha-0a1b2c3d4e5f60718293a4b5c6d7e8f901234567")).toBe(true);
    // Builds published before the staging branch existed: a rollback target.
    expect(accepts("main-0a1b2c3")).toBe(true);

    // `latest`, `stable` and `staging` move; the rest is an injection attempt.
    for (const tag of [
      "latest",
      "stable",
      "staging",
      "staging-0a1b2c3",
      "sha-0a1b2c3; id",
      "sha-XYZ1234",
      "invalid",
      "",
    ]) {
      expect(accepts(tag), tag).toBe(false);
    }
  });

  it("never reaches a shell as raw workflow syntax", () => {
    for (const each of evidence.steps) {
      expect(each.run, each.name).not.toContain("${{");
    }
    for (const each of deploy.steps) {
      expect(each.run, each.name).not.toContain("${{");
    }
  });

  it("is what `stable` moves to: the digest read from it before the approval", () => {
    const digests = stepOf(evidence, "Read the digests to promote");

    // The build the staging check settled on (the commit's own, or the
    // documentation rule's), never the raw candidate.
    expect(digests.text).toContain(
      "IMAGE_TAG: ${{ steps.staged.outputs.tag }}",
    );
    expect(digests.run).toContain(
      'api=$(bash .github/scripts/ghcr.sh digest "ghcr.io/trajetto-organization/trajetto-api:${IMAGE_TAG}")',
    );
    expect(evidence.text).toContain(
      "api_digest: ${{ steps.digests.outputs.api }}",
    );
    expect(input(promote, "api-digest")).toBe(
      "${{ needs.evidence.outputs.api_digest }}",
    );
    expect(input(promote, "tag")).toBe("stable");
  });

  it("fails clearly when the build does not exist, before anything is read", () => {
    const check = index("Check the build exists in GHCR");

    expect(check).toBeGreaterThan(index("Validate the tag to promote"));
    expect(check).toBeLessThan(index("Read the digests to promote"));
    expect(stepOf(evidence, "Check the build exists in GHCR").run).toMatch(
      /::error::.*não existe/,
    );
  });
});

describe.skipIf(!hasShell("bash"))(
  "resolving the build a merge promotes",
  () => {
    let box: Sandbox;

    beforeEach(() => {
      box = sandbox();
    });

    afterEach(() => box.dispose());

    const MERGE = "f".repeat(40);
    const FIRST = "1".repeat(40);
    const HEAD = "abcdef0123456789abcdef0123456789abcdef01";

    function resolveTag(
      env: Record<string, string>,
      parents = "",
      gh = `printf '%s\\n' "${parents}"`,
    ) {
      box.stub("gh", gh);
      box.stub("sleep", "exit 0");

      return runBlock(
        box,
        stepOf(evidence, "Resolve the build to promote").run,
        {
          GITHUB_SHA: MERGE,
          REPO: "Trajetto-Organization/trajetto-api",
          INPUT_TAG: "",
          ...env,
        },
      );
    }

    it("takes the merge commit's second parent: the PR head staging built", () => {
      const result = resolveTag({ EVENT: "push" }, `${FIRST} ${HEAD}`);

      expect(result.status, result.stderr).toBe(0);
      // The full sha too: the staging check walks its history.
      expect(result.output).toBe(`tag=sha-abcdef0\ncommit=${HEAD}\n`);
      expect(box.calls("gh")[0]).toContain(
        `repos/Trajetto-Organization/trajetto-api/commits/${MERGE}`,
      );
    });

    it("takes the commit itself on a fast-forward", () => {
      const result = resolveTag({ EVENT: "push" }, FIRST);

      expect(result.status, result.stderr).toBe(0);
      expect(result.output).toBe(`tag=sha-fffffff\ncommit=${MERGE}\n`);
    });

    it("asks GitHub again when its API fails, and fails clearly when it never answers", () => {
      const counter = `${box.root}/gh-count`;

      writeFileSync(counter, "0");

      const flaky = resolveTag(
        { EVENT: "push" },
        "",
        [
          `n=$(cat "${counter}"); echo $((n + 1)) > "${counter}"`,
          '[ "$n" -eq 0 ] && { echo "HTTP 502" >&2; exit 1; }',
          `printf '%s\\n' "${FIRST} ${HEAD}"`,
        ].join("\n"),
      );

      expect(flaky.status, flaky.stderr).toBe(0);
      expect(flaky.output).toBe(`tag=sha-abcdef0\ncommit=${HEAD}\n`);
      expect(flaky.stdout).toMatch(
        /::warning::A API do GitHub falhou .*tentativa 1 de 3/,
      );

      const down = resolveTag({ EVENT: "push" }, "", "exit 1");

      expect(down.status).toBe(1);
      expect(down.output).toBe("");
      expect(down.stdout).toMatch(/::error::A API do GitHub não respondeu/);
    });

    it("hands the typed tag over, and nothing that could forge another output", () => {
      expect(
        resolveTag({ EVENT: "workflow_dispatch", INPUT_TAG: "sha-0a1b2c3" })
          .output,
      ).toBe("tag=sha-0a1b2c3\n");
      expect(box.calls("gh")).toEqual([]);

      for (const typed of [
        "sha-0a1b2c3\ndigest=sha256:evil",
        "sha-0a1b2c3; id",
        "",
      ]) {
        expect(
          resolveTag({ EVENT: "workflow_dispatch", INPUT_TAG: typed }).output,
          typed,
        ).toBe("tag=invalid\n");
      }
    });
  },
);

describe("the deploy target (DEPLOY-1)", () => {
  it("is Dokploy, through the shared scripts in the shared action, never the Portainer webhook", () => {
    for (const text of [staging.text, production.text, deploy.text]) {
      expect(text).not.toMatch(/PORTAINER/);
    }

    expect(stepOf(deploy, "Deploy the API (Dokploy)").run).toBe(
      "node .github/scripts/dokploy-deploy.mjs",
    );

    for (const job of [deployStaging, promote]) {
      // The action and its scripts are in the repository: the job checks
      // them out, then hands the environment's secrets over by name.
      expect(job.text, job.name).toMatch(
        /sparse-checkout: \|\n\s+\.github\/actions\n\s+\.github\/scripts\n/,
      );
      expect(job.text, job.name).toContain("uses: ./.github/actions/deploy\n");
      expect(input(job, "dokploy-api-key"), job.name).toBe(
        "${{ secrets.DOKPLOY_API_KEY }}",
      );
    }
  });

  it("hands the action exactly the secrets and variables of the environment, by their names", () => {
    const names = {
      "dokploy-url": "${{ secrets.DOKPLOY_URL }}",
      "dokploy-api-key": "${{ secrets.DOKPLOY_API_KEY }}",
      "dokploy-api-application-id": "${{ secrets.DOKPLOY_API_APPLICATION_ID }}",
      "dokploy-migrate-application-id":
        "${{ secrets.DOKPLOY_MIGRATE_APPLICATION_ID }}",
      "dokploy-ai-application-id": "${{ secrets.DOKPLOY_AI_APPLICATION_ID }}",
      "dokploy-pgbouncer-application-id":
        "${{ secrets.DOKPLOY_PGBOUNCER_APPLICATION_ID }}",
      "swarm-pgbouncer-service": "${{ vars.SWARM_PGBOUNCER_SERVICE }}",
      "deploy-ssh-host": "${{ secrets.DEPLOY_SSH_HOST }}",
      "deploy-ssh-user": "${{ secrets.DEPLOY_SSH_USER }}",
      "deploy-verify-ssh-key": "${{ secrets.DEPLOY_VERIFY_SSH_KEY }}",
      "deploy-ssh-known-hosts": "${{ secrets.DEPLOY_SSH_KNOWN_HOSTS }}",
      "rollout-verify": "${{ vars.ROLLOUT_VERIFY }}",
      "api-public-url": "${{ vars.API_PUBLIC_URL }}",
      "swarm-api-service": "${{ vars.SWARM_API_SERVICE }}",
    };

    for (const job of [deployStaging, promote]) {
      for (const [key, value] of Object.entries(names)) {
        expect(input(job, key), `${job.name} → ${key}`).toBe(value);
      }
    }

    // A composite action cannot read either context itself.
    expect(deploy.text).not.toMatch(/\$\{\{ (secrets|vars)\./);
  });

  it("deploys one Dokploy Application per service: AI, then API", () => {
    for (const text of [staging.text, production.text, deploy.text]) {
      expect(text).not.toMatch(/compose.deploy|DOKPLOY_COMPOSE_ID/);
      // Backups are Dokploy's Database backups: no backup service ships here.
      expect(text).not.toMatch(/trajetto-backup|DOKPLOY_BACKUP_APPLICATION_ID/);
    }

    const ai = stepOf(deploy, "Deploy the AI service (Dokploy)").text;
    const api = stepOf(deploy, "Deploy the API (Dokploy)").text;

    expect(at("Deploy the AI service (Dokploy)")).toBeLessThan(
      at("Deploy the API (Dokploy)"),
    );
    expect(ai).toContain(
      "DOKPLOY_APPLICATION_ID: ${{ inputs.dokploy-ai-application-id }}",
    );
    expect(api).toContain(
      "DOKPLOY_APPLICATION_ID: ${{ inputs.dokploy-api-application-id }}",
    );
    // The AI may not exist yet; the API may not be skipped.
    expect(ai).toContain('DOKPLOY_OPTIONAL: "true"');
    expect(api).toContain("DOKPLOY_APP_LABEL: trajetto-api");
    expect(api).not.toContain("DOKPLOY_OPTIONAL");
  });

  it("protects production with its own environment, and staging with its", () => {
    expect(promote.text).toContain("environment: production");
    expect(deployStaging.text).toContain("environment: staging");
    // Only those two jobs carry an environment: no secret of one reaches
    // any other job.
    for (const workflow of [staging, production, pr, validate]) {
      for (const job of workflow.jobs) {
        if (job === promote || job === deployStaging) continue;
        expect(job.text, `${workflow.file} → ${job.name}`).not.toMatch(
          /\n {4}environment:/,
        );
      }
    }
  });

  it("deploys each service only after its tag moved, the API's last", () => {
    expect(at("Move the AI tag to this build")).toBeLessThan(
      at("Deploy the AI service (Dokploy)"),
    );
    expect(at("Deploy the AI service (Dokploy)")).toBeLessThan(
      at("Move the API tag to this build"),
    );
    expect(at("Move the API tag to this build")).toBeLessThan(
      at("Deploy the API (Dokploy)"),
    );
  });

  it("moves staging to this run's digests, never to a tag", () => {
    expect(input(deployStaging, "api-digest")).toBe(
      "${{ needs.build.outputs.api_digest }}",
    );
    expect(input(deployStaging, "tag")).toBe("staging");
    expect(stepOf(deploy, "Move the API tag to this build").run).toContain(
      '"ghcr.io/trajetto-organization/trajetto-api@${API_DIGEST}"',
    );
    expect(stepOf(deploy, "Move the AI tag to this build").run).toContain(
      '"ghcr.io/trajetto-organization/trajetto-ai@${AI_DIGEST}"',
    );
  });

  it("releases only after production was promoted", () => {
    expect(jobOf(production, "release").text).toContain(
      "needs: promote-production",
    );
  });
});

describe.skipIf(!hasShell("bash"))("before Dokploy exists", () => {
  let box: Sandbox;

  beforeEach(() => {
    box = sandbox();
  });

  afterEach(() => box.dispose());

  const SECRETS = {
    DOKPLOY_URL: "https://dokploy.example.com",
    DOKPLOY_API_KEY: "key-never-printed",
    DOKPLOY_API_APPLICATION_ID: "abc123",
    DOKPLOY_MIGRATE_APPLICATION_ID: "def456",
  };

  const configured = (environment: string, env: Record<string, string>) =>
    runBlock(box, stepOf(deploy, "Check deploy settings").run, {
      ENVIRONMENT: environment,
      TAG: environment === "production" ? "stable" : "staging",
      DOKPLOY_URL: "",
      DOKPLOY_API_KEY: "",
      DOKPLOY_API_APPLICATION_ID: "",
      DOKPLOY_MIGRATE_APPLICATION_ID: "",
      ...env,
    });

  it.each(["staging", "production"])(
    "%s skips the deploy with a notice, deploys when configured, fails when half-configured",
    (environment) => {
      const none = configured(environment, {});

      expect(none.status, none.stderr).toBe(0);
      expect(none.output).toBe("enabled=false\n");
      expect(none.stdout).toContain("::notice::");
      expect(none.stdout).toContain(`environment ${environment}`);

      const all = configured(environment, SECRETS);

      expect(all.status).toBe(0);
      expect(all.output).toBe("enabled=true\n");
      expect(all.log).not.toContain("key-never-printed");

      const half = configured(environment, {
        DOKPLOY_URL: SECRETS.DOKPLOY_URL,
      });

      expect(half.status).not.toBe(0);
      expect(half.stdout).toMatch(
        /::error::.*DOKPLOY_API_KEY DOKPLOY_API_APPLICATION_ID DOKPLOY_MIGRATE_APPLICATION_ID/,
      );
    },
  );

  it("follows the answer in the deploy and its checks; the staged marker does not", () => {
    // Before Dokploy exists the tags are all there is (as in the web), and
    // the marker still runs only after every step before it passed; so do
    // the tags of the roles not deployed (plano-escala F3-31a), which
    // follow the API's digest with or without Dokploy.
    const after = deploy.steps.slice(at("Deploy the API (Dokploy)"));
    const tagsOnly = [
      "Mark this build as staged",
      "Move the tags of the roles not deployed",
    ];

    expect(after.length).toBeGreaterThan(4);
    for (const step of after) {
      if (tagsOnly.includes(step.name)) {
        expect(conditionOf(step)).not.toContain("dokploy");
        continue;
      }

      // The rollout checks follow the pick, which only runs when enabled.
      expect(conditionOf(step), step.name).toMatch(
        /steps\.dokploy\.outputs\.enabled == 'true'|steps\.verify\.outputs\.mode == '/,
      );
    }
    expect(conditionOf(stepOf(deploy, "Pick the rollout check"))).toContain(
      "steps.dokploy.outputs.enabled == 'true'",
    );
  });
});

describe("the pull request into main", () => {
  const check = jobOf(pr, "evidence");

  it("waits for staging to have DEPLOYED its head, so the merge promotes a build staging ran", () => {
    const wait = stepOf(check, "Wait for the staging build of the head");

    expect(wait.text).toContain(
      "HEAD_SHA: ${{ github.event.pull_request.head.sha }}",
    );
    // `sha-<sha>` exists as soon as the build pushed it, also when the scan
    // or the staging deploy failed afterwards: the marker is the proof, on
    // the same digest — the question staged-build.sh answers, for the PR
    // check and the promote alike (staged-build.test.ts).
    expect(wait.run).toContain(
      'bash .github/scripts/staged-build.sh "$HEAD_SHA"',
    );
    expect(wait.run).toContain("for attempt in $(seq 1 90); do");
    expect(check.text).toContain("packages: read");
    expect(check.text).not.toContain("packages: write");
    // The documentation rule compares the head with older commits: the PR
    // head itself, with its history.
    expect(check.text).toContain(
      "ref: ${{ github.event.pull_request.head.sha }}",
    );
    expect(check.text).toContain("fetch-depth: 0");
    // The ruleset requires the check by this name.
    expect(check.text).toContain("name: Staging evidence");
  });

  it("does not validate again: no lint, test or build, only the evidence and the scan", () => {
    expect(pr.jobs.map((job) => job.name)).toEqual(["secrets", "evidence"]);
    expect(pr.text).not.toMatch(/validate\.yml|yarn |npx /);
  });

  it("checks the Gate of the build the merge promotes, after the marker settled which one", () => {
    const names = stepNames(check);
    const gate = stepOf(check, "Check the staging gate of this build");

    expect(names.indexOf("Wait for the staging build of the head")).toBe(
      names.indexOf("Check the staging gate of this build") - 1,
    );
    expect(
      stepOf(check, "Wait for the staging build of the head").text,
    ).toContain("id: staged");
    expect(gate.text).toContain("COMMIT: ${{ steps.staged.outputs.commit }}");
    expect(gate.run).toContain('bash .github/scripts/check-gate.sh "$COMMIT"');
    expect(check.text).toContain("checks: read");
    // check-gate.sh reads which workflow and branch ran the Gate.
    expect(check.text).toContain("actions: read");
  });

  // A head that only adds documentation ships an older build, whose Gate
  // says nothing about that documentation: the head's own run (`Docs`) does.
  // Without this, a guide that broke the documentation tests reached main
  // with nothing blocking it, where the old PR validation stopped it.
  it("checks the Gate of a documentation head too, waiting for its run", () => {
    const names = stepNames(check);
    const head = stepOf(check, "Check the staging gate of the PR head");

    expect(names.indexOf("Check the staging gate of the PR head")).toBe(
      names.indexOf("Check the staging gate of this build") + 1,
    );
    expect(conditionOf(head)).toBe(
      "steps.staged.outputs.commit != github.event.pull_request.head.sha",
    );
    expect(head.text).toContain(
      "HEAD_SHA: ${{ github.event.pull_request.head.sha }}",
    );
    expect(head.text).toMatch(/GATE_WAIT_ROUNDS: "\d+"/);
    expect(head.run).toContain(
      'bash .github/scripts/check-gate.sh "$HEAD_SHA"',
    );
    // The wait fits in the job, after the marker's.
    const rounds = Number(/GATE_WAIT_ROUNDS: "(\d+)"/.exec(head.text)?.[1]);

    expect(timeoutOf(check)).toBeGreaterThan(45 + (rounds * 30) / 60);
  });

  it("reads any Gate that is not green, or not there, as a refusal", () => {
    for (const [owner, name] of [
      [check, "Check the staging gate of this build"],
      [check, "Check the staging gate of the PR head"],
      [evidence, "Check the staging gate of this build"],
      [evidence, "Check the staging gate of the merged head"],
    ] as const) {
      expect(stepOf(owner, name).run, name).toMatch(/\n {2}3 \| 4\)\n/);
    }
  });

  it("refuses a main that has code the head does not, before waiting on anything", () => {
    const names = stepNames(check);
    const main = stepOf(check, "Check main adds only documentation");

    expect(names.indexOf("Check main adds only documentation")).toBeLessThan(
      names.indexOf("Wait for the staging build of the head"),
    );
    expect(main.text).toContain(
      "BASE_SHA: ${{ github.event.pull_request.base.sha }}",
    );
    expect(main.run).toContain(
      'bash .github/scripts/docs-only.sh "$fork" "$BASE_SHA"',
    );
  });
});

describe("a commit that only changes documentation (D11)", () => {
  it("is promoted with the build of the nearest commit staging ran, by the same rule as the PR check", () => {
    const check = stepOf(evidence, "Check that staging ran this build");

    expect(check.text).toContain("id: staged");
    expect(check.text).toContain(
      "CANDIDATE: ${{ steps.target.outputs.commit }}",
    );
    expect(check.run).toContain(
      'bash .github/scripts/staged-build.sh "$CANDIDATE"',
    );
    // The history it walks.
    expect(stepOf(evidence, "Check out the scripts").text).toMatch(
      /with:\n\s+fetch-depth: 0\n/,
    );
  });

  it("settles the build before anything reads it, and every later step uses that answer", () => {
    const staged = index("Check that staging ran this build");

    expect(staged).toBeGreaterThan(index("Validate the tag to promote"));
    expect(staged).toBeLessThan(index("Check the build exists in GHCR"));
    expect(staged).toBeLessThan(index("Read the digests to promote"));

    for (const each of evidence.steps.slice(staged + 1)) {
      expect(each.text, each.name).not.toContain(
        "${{ steps.target.outputs.tag }}",
      );
    }

    for (const name of [
      "Check the build exists in GHCR",
      "Compare with what staging runs",
      "Read the digests to promote",
    ]) {
      expect(stepOf(evidence, name).text, name).toContain(
        "IMAGE_TAG: ${{ steps.staged.outputs.tag }}",
      );
    }
    expect(evidence.text).toContain("tag: ${{ steps.staged.outputs.tag }}");
  });

  it("checks the Gate only on a merge: a rollback is exempt, as from the marker", () => {
    expect(
      conditionOf(stepOf(evidence, "Check the staging gate of this build")),
    ).toBe("github.event_name == 'push'");
  });

  it("checks the Gate of the merged head too, when it only adds documentation to the build", () => {
    const head = stepOf(evidence, "Check the staging gate of the merged head");

    expect(conditionOf(head)).toBe(
      "github.event_name == 'push' && steps.staged.outputs.commit != steps.target.outputs.commit",
    );
    expect(head.text).toContain(
      "CANDIDATE: ${{ steps.target.outputs.commit }}",
    );
    expect(head.run).toContain(
      'bash .github/scripts/check-gate.sh "$CANDIDATE"',
    );
    expect(index("Check the staging gate of the merged head")).toBe(
      index("Check the staging gate of this build") + 1,
    );
    expect(evidence.text).toContain("actions: read");
  });

  it("is documented as the one safe use of [skip ci]", () => {
    const doc = read("docs", "deploy.md");

    expect(doc).toMatch(/### Commits só de documentação/);
    expect(doc).toMatch(/\[skip ci\]/);
  });
});

describe("the production Applications", () => {
  /**
   * The production API Application runs `:stable` (its Docker image field in
   * Dokploy, docs/deploy.md), so a rollback through the button only works if
   * every promote moves `stable`. A switch on that step once left the typed
   * `image_tag` unused: a green run that redeployed the bad build.
   */
  it("always moves the environment's tag to the build being promoted, under no other condition", () => {
    const move = stepOf(deploy, "Move the API tag to this build");

    expect(conditionOf(move)).toBe("steps.head.outputs.current == 'true'");
    expect(input(promote, "require-branch-head")).toBe('"false"');
    // Through ghcr.sh, which retries a GHCR hiccup instead of failing the
    // promote on it (ghcr-script.test.ts).
    expect(move.run).toMatch(
      /bash \.github\/scripts\/ghcr\.sh tag \\\n\s+"ghcr\.io\/trajetto-organization\/trajetto-api:\$\{TAG\}" \\\n/,
    );
  });
});
