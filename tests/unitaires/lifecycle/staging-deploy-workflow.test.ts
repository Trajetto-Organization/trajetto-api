import { writeFileSync } from "node:fs";

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
  type Action,
  type Job,
} from "./support/workflow-text";

/**
 * What the staging road ships, and what it lets through to production.
 *
 * - The AI image was rebuilt on every push and got a new digest every time
 *   (labels), and its deploy step had no condition: every API push restarted
 *   the AI and sent ~200 MB over the VPS's IPv6 route to GHCR, which resets
 *   connections mid-download (run 40551925038 failed 3/3 on it). Now it is
 *   reused by the git hash of infra/ai-ocr and redeployed only when its
 *   digest changes.
 * - Both `staging` tags moved before either deploy, and the PR check and the
 *   promote only asked whether `sha-<sha>` existed — pushed before the scan,
 *   and left in GHCR when the scan or the staging deploy failed. A commit
 *   staging never ran could be merged and promoted. Now the deploy writes
 *   `staged-<sha>` last, and both checks require it on the same digests (as
 *   trajetto-ui already did).
 * - Staging and production deploy through the same composite action
 *   (.github/actions/deploy), so the order — migrations, AI, API, proof —
 *   and the tag handling are one piece of code, run with each environment's
 *   inputs.
 *
 * The `run:` blocks are executed with docker, git and sleep stubbed: a tag
 * table stands in for GHCR.
 */
const staging = readWorkflow("staging.yml");
const pr = readWorkflow("pr.yml");
const production = readWorkflow("production.yml");
const deploy = readAction("deploy");
const build = jobOf(staging, "build");

const REPO = "ghcr.io/trajetto-organization";
const SHA = "abcdef0123456789abcdef0123456789abcdef01";
const TREE = "1234567890abcdef1234567890abcdef12345678";
const digest = (char: string) => `sha256:${char.repeat(64)}`;

/** The `with:` value an environment's deploy job hands the action. */
function input(job: Job, key: string): string | undefined {
  return new RegExp(`\\n {10}${key}: (.+)\\n`).exec(`${job.text}\n`)?.[1];
}

describe.skipIf(!hasShell("bash"))(
  "the staging road, run with GHCR stubbed",
  () => {
    let box: Sandbox;

    beforeEach(() => {
      box = sandbox();
      // `docker buildx imagetools inspect <ref> --format …` answers from the
      // tag table; anything else (create) is only recorded.
      box.stub(
        "docker",
        [
          'if [ "$1 $2 $3" = "buildx imagetools inspect" ]; then',
          `  found=$(awk -v ref="$4" '$1 == ref { print $2 }' "${box.root}/tags")`,
          '  [ -n "$found" ] || { echo "not found" >&2; exit 1; }',
          '  printf "%s\\n" "$found"',
          "fi",
        ].join("\n"),
      );
      box.stub("git", `printf '%s\\n' "${TREE}"`);
      box.stub("sleep", "exit 0");
    });

    afterEach(() => box.dispose());

    /** Runs a step of a job or of the deploy action, from the repository. */
    function step(
      owner: Job | Action,
      name: string,
      tags: Record<string, string>,
      env: Record<string, string> = {},
    ) {
      writeFileSync(
        `${box.root}/tags`,
        Object.entries(tags)
          .map(([ref, value]) => `${REPO}/${ref} ${value}\n`)
          .join(""),
      );

      const result = runBlock(
        box,
        stepOf(owner, name).run,
        { GITHUB_SHA: SHA, FORCE: "", ...env },
        process.cwd(),
      );

      return {
        ...result,
        created: box
          .calls("docker")
          .filter((call) => call.includes("imagetools create")),
      };
    }

    describe("the AI image, reused by its source", () => {
      const SOURCE = "Look up the AI image for this source";

      it("is reused when an image was built from the same infra/ai-ocr", () => {
        const result = step(build, SOURCE, {
          [`trajetto-ai:src-${TREE}`]: digest("a"),
        });

        expect(result.status, result.stderr).toBe(0);
        expect(result.outputs).toEqual({
          tree: TREE,
          build: "false",
          digest: digest("a"),
        });
      });

      it("is built when no image has that source", () => {
        const result = step(build, SOURCE, {});

        expect(result.status, result.stderr).toBe(0);
        expect(result.outputs).toEqual({ tree: TREE, build: "true" });
      });

      it("fails, naming GHCR, when the registry does not answer — it used to rebuild", () => {
        // An answer that is not a digest is GHCR misbehaving, not "no such
        // image" (ghcr.sh tries it again, then fails).
        const result = step(build, SOURCE, {
          [`trajetto-ai:src-${TREE}`]: "garbage",
        });

        expect(result.status).not.toBe(0);
        expect(result.outputs.build).toBeUndefined();
        expect(result.stderr).toMatch(/::error::GHCR indisponível/);
      });

      it("is built anyway with force_ai_build, without even asking GHCR", () => {
        const result = step(
          build,
          SOURCE,
          { [`trajetto-ai:src-${TREE}`]: digest("a") },
          { FORCE: "true" },
        );

        expect(result.status, result.stderr).toBe(0);
        expect(result.outputs.build).toBe("true");
        expect(box.calls("docker")).toEqual([]);
        expect(result.stdout).toContain("::notice::force_ai_build");
      });

      it("gets this commit's sha-<sha> registry-side, so the PR check and the promote find it", () => {
        const result = step(
          build,
          "Tag the reused AI image for this commit",
          {},
          { DIGEST: digest("a") },
        );

        expect(result.status, result.stderr).toBe(0);
        expect(result.created).toEqual([
          `docker buildx imagetools create --tag ${REPO}/trajetto-ai:sha-abcdef0 ${REPO}/trajetto-ai@${digest("a")}`,
        ]);
      });

      it("is built, tagged, scanned and deployed on the right conditions", () => {
        for (const name of [
          "Extract metadata (ai)",
          "Build and push the AI image",
        ]) {
          expect(stepOf(build, name).text, name).toContain(
            "if: steps.ai-source.outputs.build == 'true'",
          );
        }
        expect(
          stepOf(build, "Tag the reused AI image for this commit").text,
        ).toContain("if: steps.ai-source.outputs.build == 'false'");
        // What the commit ships — built or reused — is what deploys and what
        // the scan reads.
        const either =
          "${{ steps.build-ai.outputs.digest || steps.ai-source.outputs.digest }}";

        expect(build.text).toContain(`ai_digest: ${either}`);
        expect(jobOf(staging, "image-scan").text).toContain(
          "AI_IMAGE: ghcr.io/trajetto-organization/trajetto-ai@${{ needs.build.outputs.ai_digest }}",
        );
        expect(input(jobOf(staging, "deploy-staging"), "ai-digest")).toBe(
          "${{ needs.build.outputs.ai_digest }}",
        );
        // Every build of the AI carries the commit for GET /health.
        expect(stepOf(build, "Build and push the AI image").text).toContain(
          "GIT_SHA=${{ github.sha }}",
        );
        expect(stepOf(build, "Build and push the API image").text).toContain(
          "GIT_SHA=${{ github.sha }}",
        );
      });
    });

    // The Database's image (trajetto-postgres, plano-escala F1-03):
    // published only for a new infra/postgres that the Postgres image job
    // tested, never deployed, and never in the way of the API's road.
    describe("the Database's image, published only for a new infra/postgres", () => {
      const SOURCE = "Look up the Postgres image for this source";

      it("publishes nothing when the same infra/postgres is already published", () => {
        const result = step(
          build,
          SOURCE,
          { [`trajetto-postgres:src-${TREE}`]: digest("c") },
          { TESTED: "false" },
        );

        expect(result.status, result.stderr).toBe(0);
        expect(result.outputs).toEqual({
          tree: TREE,
          build: "false",
          digest: digest("c"),
        });
      });

      it("publishes a new source the Postgres image job tested", () => {
        const result = step(build, SOURCE, {}, { TESTED: "true" });

        expect(result.status, result.stderr).toBe(0);
        expect(result.outputs).toEqual({ tree: TREE, build: "true" });
      });

      it("never publishes a source the job did not test", () => {
        const result = step(build, SOURCE, {}, { TESTED: "false" });

        expect(result.status, result.stderr).toBe(0);
        expect(result.outputs).toEqual({ tree: TREE, build: "false" });
        expect(result.stdout).toMatch(/::warning::trajetto-postgres:src-/);
      });

      it("lets the API through, with a warning, when GHCR does not answer about it", () => {
        const result = step(
          build,
          SOURCE,
          { [`trajetto-postgres:src-${TREE}`]: "garbage" },
          { TESTED: "true" },
        );

        expect(result.status, result.stderr).toBe(0);
        expect(result.outputs).toEqual({ tree: TREE, build: "false" });
        expect(result.stdout).toMatch(
          /::warning::O GHCR não respondeu sobre trajetto-postgres/,
        );
      });

      it("is smoke-tested, pushed with attestations and summarised only when built, and deployed nowhere", () => {
        for (const name of [
          "Extract metadata (postgres)",
          "Build the Postgres image for the smoke test",
          "Smoke test the Postgres image",
          "Build and push the Postgres image",
        ]) {
          expect(conditionOf(stepOf(build, name)), name).toBe(
            "steps.postgres-source.outputs.build == 'true'",
          );
        }
        const push = stepOf(build, "Build and push the Postgres image").text;

        expect(push).toContain("context: ./infra/postgres");
        expect(push).toContain("sbom: true");
        expect(push).toContain("provenance: mode=max");
        expect(push).toContain("GIT_SHA=${{ github.sha }}");
        expect(push).toContain("type=gha,scope=postgres-test");
        expect(stepOf(build, SOURCE).text).toContain(
          "TESTED: ${{ needs.changes.outputs.postgres }}",
        );
        expect(build.text).toContain(
          "postgres_digest: ${{ steps.build-postgres.outputs.digest || steps.postgres-source.outputs.digest }}",
        );
        expect(stepOf(build, "Summary").run).toContain(
          "Troca no Database: ação do dono",
        );
        for (const text of [
          jobOf(staging, "deploy-staging").text,
          deploy.text,
        ]) {
          expect(text).not.toContain("postgres_digest");
          expect(text).not.toContain("trajetto-postgres");
        }
      });

      describe("its scan", () => {
        const SCAN = stepOf(
          jobOf(staging, "image-scan"),
          "Scan the images",
        ).run;

        /** Trivy finds a fixable CRITICAL in the images whose name matches. */
        function scan(findingIn: string, env: Record<string, string>) {
          box.stub(
            "docker",
            `case "$*" in *${findingIn}*) exit 3 ;; esac\nexit 0`,
          );

          return runBlock(
            box,
            SCAN,
            {
              DB: "fresh",
              TRIVY_IMAGE: "aquasec/trivy:test",
              API_IMAGE: `${REPO}/trajetto-api@${digest("1")}`,
              MIGRATE_IMAGE: `${REPO}/trajetto-api-migrate@${digest("2")}`,
              AI_IMAGE: `${REPO}/trajetto-ai@${digest("3")}`,
              DATABASE_IMAGE: "",
              ENFORCE: "true",
              ...env,
            },
            process.cwd(),
          );
        }

        it("reads the Database's image only when this run built it", () => {
          expect(
            stepOf(jobOf(staging, "image-scan"), "Scan the images").text,
          ).toContain(
            "DATABASE_IMAGE: ${{ needs.build.outputs.postgres_built == 'true' && format('ghcr.io/trajetto-organization/trajetto-postgres@{0}', needs.build.outputs.postgres_digest) || '' }}",
          );

          const result = scan("nothing-matches", {});

          expect(result.status, result.stderr).toBe(0);
          expect(
            box
              .calls("docker")
              .filter((call) => call.includes("trajetto-postgres")),
          ).toEqual([]);
        });

        it("only reports its finding, enforced or not: it must not hold the API's deploy", () => {
          const result = scan("trajetto-postgres", {
            DATABASE_IMAGE: `${REPO}/trajetto-postgres@${digest("4")}`,
          });

          expect(result.status, result.stderr).toBe(0);
          expect(result.stdout).toMatch(
            /::warning::Trivy: CRITICAL corrigível em trajetto-postgres/,
          );
          expect(result.summary).toContain("a troca do Database é do dono");
        });

        it("still fails, enforced, on a finding in an image that deploys", () => {
          const result = scan("trajetto-api@", {
            DATABASE_IMAGE: `${REPO}/trajetto-postgres@${digest("4")}`,
          });

          expect(result.status).toBe(1);
          expect(result.stdout).toMatch(
            /::error::Trivy: CRITICAL corrigível em trajetto-api/,
          );
        });
      });

      describe("its smoke test", () => {
        const SMOKE = stepOf(build, "Smoke test the Postgres image").run;

        function smoke(answers: Record<string, string>) {
          box.stub(
            "docker",
            `
case "$1" in
  run) echo cid-postgres ;;
  logs) printf 'ready to accept connections\\nready to accept connections\\n' ;;
  exec)
    case "$*" in
      *pg_isready*) exit 0 ;;
      *"SHOW shared_buffers"*) echo "${answers.shared_buffers ?? "108MB"}" ;;
      *"SHOW archive_mode"*) echo "${answers.archive_mode ?? "off"}" ;;
      *"SHOW trajetto.image_revision"*) echo "${answers.revision ?? SHA}" ;;
    esac ;;
esac
exit 0`,
          );

          return runBlock(
            box,
            SMOKE,
            { GITHUB_SHA: SHA, IMAGE: "trajetto-postgres:smoke" },
            process.cwd(),
          );
        }

        it("starts it as staging's Database, capped and offline, and reads back what it derived", () => {
          const result = smoke({});

          expect(result.status, result.stderr).toBe(0);
          const run =
            box.calls("docker").find((call) => call.startsWith("docker run")) ??
            "";
          expect(run).toContain("--network none --memory 603979776");
          expect(run).toContain("POSTGRES_MEMORY_LIMIT_MB=576");
          expect(result.summary).toContain("smoke test OK");
        });

        it.each([
          [
            "shared_buffers not derived from the cap",
            { shared_buffers: "128MB" },
          ],
          ["archiving on without PITR_ARCHIVE", { archive_mode: "on" }],
          ["another commit's image", { revision: "0".repeat(40) }],
        ])("fails on %s, before anything is pushed", (_, answers) => {
          const result = smoke(answers);

          expect(result.status).toBe(1);
          expect(result.stdout).toContain(
            "::error::Smoke test da imagem trajetto-postgres",
          );
        });
      });
    });

    describe("the AI deploy, only when its digest changed", () => {
      const CURRENT = "Read what the environment runs now";

      it("is skipped when the environment already runs that digest", () => {
        const result = step(
          deploy,
          CURRENT,
          {
            "trajetto-api:staging": digest("1"),
            "trajetto-ai:staging": digest("a"),
          },
          { TAG: "staging", AI_DIGEST: digest("a") },
        );

        expect(result.status, result.stderr).toBe(0);
        expect(result.outputs).toEqual({
          api: digest("1"),
          ai: digest("a"),
          ai_deploy: "false",
        });
      });

      it("runs when the digest changed, when the environment has none yet, or when forced", () => {
        for (const [tags, env] of [
          [{ "trajetto-ai:staging": digest("b") }, { AI_DIGEST: digest("a") }],
          [{}, { AI_DIGEST: digest("a") }],
          [
            { "trajetto-ai:staging": digest("a") },
            { AI_DIGEST: digest("a"), FORCE: "true" },
          ],
        ] as Array<[Record<string, string>, Record<string, string>]>) {
          const result = step(deploy, CURRENT, tags, {
            TAG: "staging",
            ...env,
          });

          expect(result.status, result.stderr).toBe(0);
          expect(result.outputs.ai_deploy, JSON.stringify(env)).toBe("true");
        }
      });

      it("reads the tag of the environment it deploys", () => {
        const result = step(
          deploy,
          CURRENT,
          {
            "trajetto-api:stable": digest("2"),
            "trajetto-ai:stable": digest("b"),
            "trajetto-ai:staging": digest("a"),
          },
          { TAG: "stable", AI_DIGEST: digest("a") },
        );

        expect(result.outputs).toEqual({
          api: digest("2"),
          ai: digest("b"),
          ai_deploy: "true",
        });
      });

      it("leaves the AI where it is for a build older than the service", () => {
        const result = step(
          deploy,
          CURRENT,
          { "trajetto-ai:stable": digest("a") },
          { TAG: "stable", AI_DIGEST: "" },
        );

        expect(result.status, result.stderr).toBe(0);
        expect(result.outputs.ai_deploy).toBe("false");
        expect(result.stdout).toContain(
          "::warning::Este build não tem imagem trajetto-ai",
        );
      });

      it("moves each tag right before its own deploy, the AI's only when it deploys", () => {
        const names = stepNames(deploy);
        const at = (name: string) => names.indexOf(name);

        expect(at("Read what the environment runs now")).toBeLessThan(
          at("Move the AI tag to this build"),
        );
        expect(at("Move the AI tag to this build")).toBeLessThan(
          at("Deploy the AI service (Dokploy)"),
        );
        expect(at("Deploy the AI service (Dokploy)")).toBeLessThan(
          at("Move the API tag to this build"),
        );
        expect(at("Move the API tag to this build")).toBeLessThan(
          at("Deploy the API (Dokploy)"),
        );

        for (const name of [
          "Move the AI tag to this build",
          "Deploy the AI service (Dokploy)",
        ]) {
          expect(conditionOf(stepOf(deploy, name)), name).toContain(
            "steps.current.outputs.ai_deploy == 'true'",
          );
        }
        expect(
          conditionOf(stepOf(deploy, "Deploy the API (Dokploy)")),
        ).not.toContain("ai_deploy");
      });

      it("moves the tags by digest, to the environment's tag", () => {
        const ai = step(
          deploy,
          "Move the AI tag to this build",
          {},
          { TAG: "stable", AI_DIGEST: digest("a") },
        );
        const api = step(
          deploy,
          "Move the API tag to this build",
          {},
          { TAG: "stable", API_DIGEST: digest("1") },
        );

        expect(ai.status, ai.stderr).toBe(0);
        // The call log is the sandbox's: the second run sees both calls.
        expect(api.created).toEqual([
          `docker buildx imagetools create --tag ${REPO}/trajetto-ai:stable ${REPO}/trajetto-ai@${digest("a")}`,
          `docker buildx imagetools create --tag ${REPO}/trajetto-api:stable ${REPO}/trajetto-api@${digest("1")}`,
        ]);
      });
    });

    describe("a failed Dokploy deploy", () => {
      const RESTORE = "Put the tags back after a failed deploy";
      const previous = { PREVIOUS_API: digest("1"), PREVIOUS_AI: digest("a") };

      it("puts back, on staging, the tag of the service that failed, and only that one", () => {
        const ai = step(
          deploy,
          RESTORE,
          {},
          {
            ...previous,
            TAG: "staging",
            RESTORE_API: "true",
            AI_DEPLOY: "failure",
            API_DEPLOY: "skipped",
          },
        );

        expect(ai.status, ai.stderr).toBe(0);
        expect(ai.created).toEqual([
          `docker buildx imagetools create --tag ${REPO}/trajetto-ai:staging ${REPO}/trajetto-ai@${digest("a")}`,
        ]);

        box.dispose();
        box = sandbox();
        box.stub("docker", "exit 0");

        const api = step(
          deploy,
          RESTORE,
          {},
          {
            ...previous,
            TAG: "staging",
            RESTORE_API: "true",
            AI_DEPLOY: "success",
            API_DEPLOY: "failure",
          },
        );

        expect(api.status, api.stderr).toBe(0);
        expect(api.created).toEqual([
          `docker buildx imagetools create --tag ${REPO}/trajetto-api:staging ${REPO}/trajetto-api@${digest("1")}`,
        ]);
      });

      it("puts back only the AI's in production: a failed promote is fixed by promoting again", () => {
        const result = step(
          deploy,
          RESTORE,
          {},
          {
            ...previous,
            TAG: "stable",
            RESTORE_API: "false",
            AI_DEPLOY: "failure",
            API_DEPLOY: "failure",
          },
        );

        expect(result.status, result.stderr).toBe(0);
        expect(result.created).toEqual([
          `docker buildx imagetools create --tag ${REPO}/trajetto-ai:stable ${REPO}/trajetto-ai@${digest("a")}`,
        ]);
        expect(input(jobOf(staging, "deploy-staging"), "restore-api-tag")).toBe(
          '"true"',
        );
        expect(
          input(jobOf(production, "promote-production"), "restore-api-tag"),
        ).toBe('"false"');
      });

      it("leaves the tags alone when a check failed, not a deploy, or when there was no tag before", () => {
        const check = step(
          deploy,
          RESTORE,
          {},
          {
            ...previous,
            TAG: "staging",
            RESTORE_API: "true",
            AI_DEPLOY: "success",
            API_DEPLOY: "success",
          },
        );

        expect(check.status, check.stderr).toBe(0);
        expect(check.created).toEqual([]);

        const first = step(
          deploy,
          RESTORE,
          {},
          {
            PREVIOUS_API: "",
            PREVIOUS_AI: "",
            TAG: "staging",
            RESTORE_API: "true",
            AI_DEPLOY: "failure",
            API_DEPLOY: "failure",
          },
        );

        expect(first.status, first.stderr).toBe(0);
        expect(first.created).toEqual([]);
        expect(first.stdout).toContain("::warning::");
      });

      it("runs only after a failure, as the last step", () => {
        const last = deploy.steps[deploy.steps.length - 1];

        expect(last.name).toBe(RESTORE);
        expect(conditionOf(last)).toBe(
          "steps.head.outputs.current == 'true' && steps.dokploy.outputs.enabled == 'true' && failure()",
        );
      });
    });

    describe("the staged-<sha> marker", () => {
      it("is written for both images, on the deployed digests, after every deploy and check, on staging only", () => {
        const names = stepNames(deploy);
        const mark = names.indexOf("Mark this build as staged");

        for (const before of [
          "Deploy the AI service (Dokploy)",
          "Deploy the API (Dokploy)",
          "Wait for the API to serve this build",
          "Wait for the rollout to converge",
        ]) {
          expect(names.indexOf(before), before).toBeGreaterThan(-1);
          expect(names.indexOf(before), before).toBeLessThan(mark);
        }

        // No status function: it runs only when every step before it passed.
        expect(conditionOf(stepOf(deploy, "Mark this build as staged"))).toBe(
          "steps.head.outputs.current == 'true' && inputs.mark-staged == 'true'",
        );
        expect(input(jobOf(staging, "deploy-staging"), "mark-staged")).toBe(
          '"true"',
        );
        expect(
          input(jobOf(production, "promote-production"), "mark-staged"),
        ).toBe('"false"');

        const result = step(
          deploy,
          "Mark this build as staged",
          {},
          {
            API_DIGEST: digest("1"),
            AI_DIGEST: digest("a"),
          },
        );

        expect(result.status, result.stderr).toBe(0);
        expect(result.created).toEqual([
          `docker buildx imagetools create --tag ${REPO}/trajetto-api:staged-abcdef0 ${REPO}/trajetto-api@${digest("1")}`,
          `docker buildx imagetools create --tag ${REPO}/trajetto-ai:staged-abcdef0 ${REPO}/trajetto-ai@${digest("a")}`,
        ]);
      });

      const evidence = jobOf(pr, "evidence");
      const WAIT = "Wait for the staging build of the head";

      it("lets the pull request pass once both images are staged on their sha-<sha> digests", () => {
        const result = step(
          evidence,
          WAIT,
          {
            "trajetto-api:sha-abcdef0": digest("1"),
            "trajetto-api:staged-abcdef0": digest("1"),
            "trajetto-ai:sha-abcdef0": digest("a"),
            "trajetto-ai:staged-abcdef0": digest("a"),
          },
          { HEAD_SHA: SHA },
        );

        expect(result.status, result.stderr).toBe(0);
        expect(result.outputs).toEqual({ commit: SHA, tag: "sha-abcdef0" });
      });

      it("keeps the pull request waiting, then fails it, while a marker is missing or on another digest", () => {
        // Every image built, one staged on another digest: it keeps asking
        // (two rounds here instead of 90, sleep stubbed), then fails with the
        // error that says what to do.
        expect(stepOf(evidence, WAIT).run).toContain(
          "for attempt in $(seq 1 90); do",
        );
        box.stub("seq", "printf '1\\n2\\n'");

        const result = step(
          evidence,
          WAIT,
          {
            "trajetto-api:sha-abcdef0": digest("1"),
            "trajetto-api:staged-abcdef0": digest("2"),
            "trajetto-ai:sha-abcdef0": digest("a"),
            "trajetto-ai:staged-abcdef0": digest("a"),
          },
          { HEAD_SHA: SHA },
        );

        expect(result.status).toBe(1);
        expect(result.stdout).toMatch(
          /tentativa 2\/90: ainda sem staged-abcdef0 \(.*trajetto-api:staged-abcdef0 aponta para/,
        );
        expect(result.stdout).toMatch(
          /::error::O commit abcdef0.* não tem o marcador staged-abcdef0/,
        );
      });

      it("fails at once, naming GHCR, when the registry does not answer", () => {
        const result = step(
          evidence,
          WAIT,
          { "trajetto-api:sha-abcdef0": "garbage" },
          { HEAD_SHA: SHA },
        );

        expect(result.status).toBe(1);
        expect(result.stdout).toMatch(/::error::GHCR indisponível/);
        expect(result.stdout).not.toContain("tentativa 1/90");
      });

      it("keeps a GHCR retry visible while the pull request waits", () => {
        box.stub("seq", "printf '1\\n2\\n'");

        // The API's sha-<7> answers a 503 once, then its digest; its marker
        // never comes, so the check keeps waiting (and fails after the two
        // rounds stubbed here).
        const once = `${box.root}/once`;

        box.stub(
          "docker",
          [
            'if [ "$1 $2 $3" = "buildx imagetools inspect" ]; then',
            `  if [ "$4" = "${REPO}/trajetto-api:sha-abcdef0" ] && [ ! -e "${once}" ]; then`,
            `    : > "${once}"; echo "ERROR: 503 Service Unavailable" >&2; exit 1`,
            "  fi",
            `  found=$(awk -v ref="$4" '$1 == ref { print $2 }' "${box.root}/tags")`,
            '  [ -n "$found" ] || { echo "not found" >&2; exit 1; }',
            '  printf "%s\\n" "$found"',
            "fi",
          ].join("\n"),
        );

        const result = step(
          evidence,
          WAIT,
          { "trajetto-api:sha-abcdef0": digest("1") },
          { HEAD_SHA: SHA },
        );

        expect(result.status).toBe(1);
        expect(result.stdout).toMatch(
          /::warning::GHCR: falha ao ler ghcr\.io\/trajetto-organization\/trajetto-api:sha-abcdef0 \(tentativa 1 de 5\)/,
        );
        expect(result.stdout).toContain(
          "tentativa 2/90: ainda sem staged-abcdef0",
        );
      });

      describe("in the promote", () => {
        const promote = jobOf(production, "evidence");
        const CHECK = "Check that staging ran this build";
        const built = {
          "trajetto-api:sha-abcdef0": digest("1"),
          "trajetto-ai:sha-abcdef0": digest("a"),
        };
        const merge = {
          EVENT: "push",
          TARGET_TAG: "sha-abcdef0",
          CANDIDATE: SHA,
        };

        it("is settled before anything is checked, read or moved", () => {
          const names = stepNames(promote);

          expect(stepOf(promote, CHECK).text).toContain("id: staged");
          for (const later of [
            "Check the staging gate of this build",
            "Check the build exists in GHCR",
            "Read the digests to promote",
          ]) {
            expect(names.indexOf(CHECK), later).toBeLessThan(
              names.indexOf(later),
            );
          }
        });

        it("passes when staging ran exactly these digests, and names that build", () => {
          const result = step(
            promote,
            CHECK,
            {
              ...built,
              "trajetto-api:staged-abcdef0": digest("1"),
              "trajetto-ai:staged-abcdef0": digest("a"),
            },
            merge,
          );

          expect(result.status, result.stderr).toBe(0);
          expect(result.outputs).toEqual({ commit: SHA, tag: "sha-abcdef0" });
        });

        it("waits for a deploy still running, then refuses a build staging never ran", () => {
          box.stub("seq", "printf '1\\n2\\n'");

          const missing = step(
            promote,
            CHECK,
            {
              ...built,
              "trajetto-ai:staged-abcdef0": digest("a"),
            },
            merge,
          );

          expect(missing.status).toBe(1);
          expect(missing.outputs.tag).toBeUndefined();
          expect(missing.stdout).toContain(
            "tentativa 2/40: o staging ainda não rodou abcdef0",
          );
          expect(missing.stdout).toMatch(
            /::error::O staging nunca rodou abcdef0 .*muda mais que documentação/,
          );
        });

        it("refuses a marker on another digest once the wait is over", () => {
          box.stub("seq", "printf '1\\n'");

          const other = step(
            promote,
            CHECK,
            {
              ...built,
              "trajetto-api:staged-abcdef0": digest("1"),
              "trajetto-ai:staged-abcdef0": digest("b"),
            },
            merge,
          );

          expect(other.status).toBe(1);
          expect(other.stdout).toMatch(
            /::error::O staging nunca rodou abcdef0 .*trajetto-ai:staged-abcdef0 aponta para/,
          );
        });

        it("lets a build older than the AI service through on the API's marker alone", () => {
          const result = step(
            promote,
            CHECK,
            {
              "trajetto-api:sha-abcdef0": digest("1"),
              "trajetto-api:staged-abcdef0": digest("1"),
            },
            merge,
          );

          expect(result.status, result.stderr).toBe(0);
          expect(result.stdout).toContain(
            "::warning::trajetto-ai:sha-abcdef0 não existe",
          );
        });

        it("hands a rollback's typed tag through, exempt from the marker", () => {
          const result = step(
            promote,
            CHECK,
            {},
            {
              EVENT: "workflow_dispatch",
              TARGET_TAG: "sha-0a1b2c3",
              CANDIDATE: "",
            },
          );

          expect(result.status, result.stderr).toBe(0);
          expect(result.outputs).toEqual({ tag: "sha-0a1b2c3" });
          expect(box.calls("docker")).toEqual([]);
        });
      });
    });
  },
  30_000,
);

/**
 * The proof that the environment serves the build, after Dokploy said
 * `done` (which only means the Swarm manager accepted the spec): the public
 * liveness answering the new commit (`http`, staging's default), the Swarm
 * tasks over SSH (`ssh`, production's default), or nothing, logged (`off`).
 * Whatever ROLLOUT_VERIFY says, exactly one check runs — an empty or
 * unknown value is the environment's default, never none — and only `off`
 * skips them.
 */
describe.skipIf(!hasShell("bash"))("the rollout check of the deploy", () => {
  let box: Sandbox;

  beforeEach(() => {
    box = sandbox();
  });

  afterEach(() => box.dispose());

  const PICK = "Pick the rollout check";
  const HTTP = "Wait for the API to serve this build";
  const SSH = "Wait for the rollout to converge";
  const OFF = "Report the rollout as unverified";

  const pick = (value: string, byDefault: string) =>
    runBlock(box, stepOf(deploy, PICK).run, {
      ROLLOUT_VERIFY: value,
      DEFAULT: byDefault,
    });

  it.each([
    ["http", "staging"],
    ["ssh", "production"],
  ])(
    "runs exactly one check for every value, %s by default (%s), and none only with off",
    (byDefault) => {
      for (const value of ["", "http", "ssh", "on", "true"]) {
        const result = pick(value, byDefault);
        const expected =
          value === "http" || value === "ssh" ? value : byDefault;

        expect(result.status, result.log).toBe(0);
        expect(result.outputs, `ROLLOUT_VERIFY='${value}'`).toEqual({
          mode: expected,
        });
        if (value === "on" || value === "true") {
          expect(result.log).toContain("::warning::ROLLOUT_VERIFY=");
        }
      }

      expect(pick("off", byDefault).outputs).toEqual({ mode: "off" });
    },
  );

  it("refuses a default that is not a check", () => {
    const result = pick("", "");

    expect(result.status).toBe(1);
    expect(result.output).toBe("");
  });

  it("follows the pick, each check on its own value, after the API's deploy", () => {
    const names = stepNames(deploy);

    expect(names.indexOf(PICK)).toBe(
      names.indexOf("Deploy the API (Dokploy)") + 1,
    );
    expect(conditionOf(stepOf(deploy, PICK))).toBe(
      "steps.head.outputs.current == 'true' && steps.dokploy.outputs.enabled == 'true'",
    );

    for (const [name, mode] of [
      [HTTP, "http"],
      [SSH, "ssh"],
      [OFF, "off"],
    ]) {
      expect(names.indexOf(name), name).toBeGreaterThan(names.indexOf(PICK));
      expect(conditionOf(stepOf(deploy, name)), name).toBe(
        `steps.head.outputs.current == 'true' && steps.verify.outputs.mode == '${mode}'`,
      );
    }

    expect(input(jobOf(staging, "deploy-staging"), "verify-default")).toBe(
      "http",
    );
    expect(
      input(jobOf(production, "promote-production"), "verify-default"),
    ).toBe("ssh");
  });

  it("waits for this build's commit and digest, with the environment's settings", () => {
    const http = stepOf(deploy, HTTP);
    const ssh = stepOf(deploy, SSH);

    expect(http.text).toContain("API_URL: ${{ inputs.api-public-url }}");
    expect(http.text).toContain("EXPECTED_SHA: ${{ inputs.expected-commit }}");
    expect(http.run).toContain("node .github/scripts/wait-for-version.mjs");
    expect(ssh.text).toContain("DIGEST: ${{ inputs.api-digest }}");
    expect(ssh.text).toContain("SSH_KEY: ${{ inputs.deploy-verify-ssh-key }}");
    expect(ssh.run).toContain(
      '"$SERVICE ghcr.io/trajetto-organization/trajetto-api@${DIGEST}"',
    );

    expect(input(jobOf(staging, "deploy-staging"), "expected-commit")).toBe(
      "${{ github.sha }}",
    );
    expect(
      input(jobOf(production, "promote-production"), "expected-commit"),
    ).toBe("${{ needs.evidence.outputs.expected }}");
  });
});
