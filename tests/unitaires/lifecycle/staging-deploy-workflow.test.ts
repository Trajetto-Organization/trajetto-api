import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hasShell, run, sandbox, type Sandbox } from "./support/shell-harness";

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
 *   staging never ran could be merged and promoted. Now deploy-staging
 *   writes `staged-<sha>` last, and both checks require it on the same
 *   digests (as trajetto-ui already did).
 *
 * The `run:` blocks are executed with docker, git and sleep stubbed: a tag
 * table stands in for GHCR.
 */
const workflow = readFileSync(
  resolve(process.cwd(), ".github", "workflows", "deploy.yml"),
  "utf8",
).replace(/\r\n/g, "\n");

const jobOf = (name: string) => {
  const start = workflow.indexOf(`\n  ${name}:`);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[\w-]+:\n/);

  return start < 0 ? "" : next < 0 ? rest : rest.slice(0, next + 1);
};

const stepsOf = (job: string) =>
  jobOf(job)
    .split(/\n {6}- name: /)
    .slice(1)
    .map((chunk) => ({ name: chunk.split("\n")[0], text: chunk }));

const stepText = (job: string, name: string) =>
  stepsOf(job).find((step) => step.name === name)?.text ?? "";

/** The `run: |` block of a step, dedented. */
function runBlock(job: string, name: string): string {
  const lines = jobOf(job).split("\n");
  const at = lines.findIndex((line) => line.trim() === `- name: ${name}`);

  expect(at, `${job} → ${name}`).toBeGreaterThan(-1);

  let line = at + 1;

  while (line < lines.length && !/^\s+run: \|$/.test(lines[line])) line += 1;

  const indent = lines[line].search(/\S/) + 2;
  const body: string[] = [];

  for (let each = line + 1; each < lines.length; each += 1) {
    if (lines[each].trim() !== "" && lines[each].search(/\S/) < indent) break;

    body.push(lines[each].slice(indent));
  }

  return body.join("\n");
}

const REPO = "ghcr.io/trajetto-organization";
const SHA = "abcdef0123456789abcdef0123456789abcdef01";
const TREE = "1234567890abcdef1234567890abcdef12345678";
const digest = (char: string) => `sha256:${char.repeat(64)}`;

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

    function step(
      job: string,
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

      const output = `${box.root}/output`;
      const summary = `${box.root}/summary`;

      writeFileSync(output, "");
      writeFileSync(summary, "");

      // As GitHub runs a `run:` block: bash -e -o pipefail.
      const script = box.file(
        "step.sh",
        `set -eo pipefail\n${runBlock(job, name)}`,
      );
      const result = run("bash", script, [], {
        bin: box.bin,
        env: {
          GITHUB_SHA: SHA,
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
          FORCE: "",
          ...env,
        },
      });

      return {
        ...result,
        outputs: Object.fromEntries(
          readFileSync(output, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => line.split(/=(.*)/s).slice(0, 2)),
        ) as Record<string, string>,
        created: box
          .calls("docker")
          .filter((call) => call.includes("imagetools create")),
      };
    }

    describe("the AI image, reused by its source", () => {
      const SOURCE = "Is there an AI image for this source already?";

      it("is reused when an image was built from the same infra/ai-ocr", () => {
        const result = step("build-and-push", SOURCE, {
          [`trajetto-ai:src-${TREE}`]: digest("a"),
        });

        expect(result.status, result.stderr).toBe(0);
        expect(result.outputs).toEqual({
          tree: TREE,
          build: "false",
          digest: digest("a"),
        });
      });

      it("is built when no image has that source, or when the answer is not a digest", () => {
        const cases: Array<Record<string, string>> = [
          {},
          { [`trajetto-ai:src-${TREE}`]: "garbage" },
        ];

        for (const tags of cases) {
          const result = step("build-and-push", SOURCE, tags);

          expect(result.status, result.stderr).toBe(0);
          expect(result.outputs).toEqual({ tree: TREE, build: "true" });
        }
      });

      it("is built anyway with force_ai_build, without even asking GHCR", () => {
        const result = step(
          "build-and-push",
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
          "build-and-push",
          "Tag the reused AI image for this commit",
          {},
          { DIGEST: digest("a") },
        );

        expect(result.status, result.stderr).toBe(0);
        expect(result.created).toEqual([
          `docker buildx imagetools create --tag ${REPO}/trajetto-ai:sha-abcdef0 ${REPO}/trajetto-ai@${digest("a")}`,
        ]);
      });

      it("is built, tagged and scanned on the right conditions", () => {
        const build = jobOf("build-and-push");

        for (const name of [
          "Extract metadata (ai)",
          "Build and push the AI image",
        ]) {
          expect(stepText("build-and-push", name), name).toContain(
            "if: steps.ai-source.outputs.build == 'true'",
          );
        }
        expect(
          stepText("build-and-push", "Tag the reused AI image for this commit"),
        ).toContain("if: steps.ai-source.outputs.build == 'false'");
        // What the commit ships — built or reused — is what deploys and what
        // the scan reads.
        const either =
          "${{ steps.build-ai.outputs.digest || steps.ai-source.outputs.digest }}";

        expect(build).toContain(`ai_digest: ${either}`);
        expect(build).toContain(
          `AI_IMAGE: ghcr.io/trajetto-organization/trajetto-ai@${either}`,
        );
        // Every build of the AI carries the commit for GET /health.
        expect(
          stepText("build-and-push", "Build and push the AI image"),
        ).toContain("GIT_SHA=${{ github.sha }}");
        expect(
          stepText("build-and-push", "Build and push Docker image"),
        ).toContain("GIT_SHA=${{ github.sha }}");
      });
    });

    describe("the AI deploy, only when its digest changed", () => {
      const CURRENT = "Read what staging runs now";

      it("is skipped when staging already runs that digest", () => {
        const result = step(
          "deploy-staging",
          CURRENT,
          {
            "trajetto-api:staging": digest("1"),
            "trajetto-ai:staging": digest("a"),
          },
          { AI_DIGEST: digest("a") },
        );

        expect(result.status, result.stderr).toBe(0);
        expect(result.outputs).toEqual({
          api: digest("1"),
          ai: digest("a"),
          ai_deploy: "false",
        });
      });

      it("runs when the digest changed, when staging has none yet, or when forced", () => {
        for (const [tags, env] of [
          [{ "trajetto-ai:staging": digest("b") }, { AI_DIGEST: digest("a") }],
          [{}, { AI_DIGEST: digest("a") }],
          [
            { "trajetto-ai:staging": digest("a") },
            { AI_DIGEST: digest("a"), FORCE: "true" },
          ],
        ] as Array<[Record<string, string>, Record<string, string>]>) {
          const result = step("deploy-staging", CURRENT, tags, env);

          expect(result.status, result.stderr).toBe(0);
          expect(result.outputs.ai_deploy, JSON.stringify(env)).toBe("true");
        }
      });

      it("moves each tag right before its own deploy, the AI's only when it deploys", () => {
        const names = stepsOf("deploy-staging").map((step) => step.name);
        const at = (name: string) => names.indexOf(name);

        expect(at("Read what staging runs now")).toBeLessThan(
          at("Move the AI's staging tag to this build"),
        );
        expect(at("Move the AI's staging tag to this build")).toBeLessThan(
          at("Deploy the AI service to staging (Dokploy)"),
        );
        expect(at("Deploy the AI service to staging (Dokploy)")).toBeLessThan(
          at("Move staging to this build"),
        );
        expect(at("Move staging to this build")).toBeLessThan(
          at("Deploy to staging (Dokploy)"),
        );

        for (const name of [
          "Move the AI's staging tag to this build",
          "Deploy the AI service to staging (Dokploy)",
        ]) {
          expect(stepText("deploy-staging", name), name).toContain(
            "steps.current.outputs.ai_deploy == 'true'",
          );
        }
        expect(
          stepText("deploy-staging", "Deploy to staging (Dokploy)"),
        ).not.toContain("ai_deploy");
      });
    });

    describe("the AI in the promote", () => {
      const PROMOTE = "Promote the AI image to stable";

      it("moves `stable` by digest, and redeploys only when the digest changed (or when forced)", () => {
        const same = step(
          "promote-production",
          PROMOTE,
          {
            "trajetto-ai:sha-abcdef0": digest("a"),
            "trajetto-ai:stable": digest("a"),
          },
          { IMAGE_TAG: "sha-abcdef0" },
        );

        expect(same.status, same.stderr).toBe(0);
        expect(same.outputs).toEqual({
          previous: digest("a"),
          deploy: "false",
        });
        expect(same.created).toEqual([
          `docker buildx imagetools create --tag ${REPO}/trajetto-ai:stable ${REPO}/trajetto-ai@${digest("a")}`,
        ]);

        const changed = step(
          "promote-production",
          PROMOTE,
          {
            "trajetto-ai:sha-abcdef0": digest("b"),
            "trajetto-ai:stable": digest("a"),
          },
          { IMAGE_TAG: "sha-abcdef0" },
        );

        expect(changed.outputs).toEqual({
          previous: digest("a"),
          deploy: "true",
        });

        const forced = step(
          "promote-production",
          PROMOTE,
          {
            "trajetto-ai:sha-abcdef0": digest("a"),
            "trajetto-ai:stable": digest("a"),
          },
          { IMAGE_TAG: "sha-abcdef0", FORCE: "true" },
        );

        expect(forced.outputs.deploy).toBe("true");
      });

      it("leaves `stable` and the AI alone for a build older than the service", () => {
        const result = step(
          "promote-production",
          PROMOTE,
          {
            "trajetto-ai:stable": digest("a"),
          },
          { IMAGE_TAG: "main-0123456" },
        );

        expect(result.status, result.stderr).toBe(0);
        expect(result.outputs.deploy).toBe("false");
        expect(
          box.calls("docker").some((call) => call.includes("create")),
        ).toBe(false);
      });

      it("deploys the AI on that answer, and puts `stable` back when its deploy fails", () => {
        expect(
          stepText(
            "promote-production",
            "Deploy the AI service to production (Dokploy)",
          ),
        ).toContain("steps.ai-stable.outputs.deploy == 'true'");

        const steps = stepsOf("promote-production");
        const last = steps[steps.length - 1];

        expect(last.name).toBe(
          "Put the AI's stable tag back after a failed deploy",
        );
        expect(last.text).toContain(
          "if: steps.dokploy.outputs.enabled == 'true' && failure() && steps.deploy-ai.outcome == 'failure'",
        );

        const result = step(
          "promote-production",
          last.name,
          {},
          {
            PREVIOUS_AI: digest("a"),
          },
        );

        expect(result.status, result.stderr).toBe(0);
        expect(result.created).toEqual([
          `docker buildx imagetools create --tag ${REPO}/trajetto-ai:stable ${REPO}/trajetto-ai@${digest("a")}`,
        ]);
      });
    });

    describe("a failed Dokploy deploy", () => {
      const RESTORE = "Put the staging tags back after a failed deploy";
      const previous = { PREVIOUS_API: digest("1"), PREVIOUS_AI: digest("a") };

      it("puts back the tag of the service that failed, and only that one", () => {
        const ai = step(
          "deploy-staging",
          RESTORE,
          {},
          {
            ...previous,
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
          "deploy-staging",
          RESTORE,
          {},
          {
            ...previous,
            AI_DEPLOY: "success",
            API_DEPLOY: "failure",
          },
        );

        expect(api.status, api.stderr).toBe(0);
        expect(api.created).toEqual([
          `docker buildx imagetools create --tag ${REPO}/trajetto-api:staging ${REPO}/trajetto-api@${digest("1")}`,
        ]);
      });

      it("leaves the tags alone when a check failed, not a deploy, or when there was no tag before", () => {
        const check = step(
          "deploy-staging",
          RESTORE,
          {},
          {
            ...previous,
            AI_DEPLOY: "success",
            API_DEPLOY: "success",
          },
        );

        expect(check.status, check.stderr).toBe(0);
        expect(check.created).toEqual([]);

        const first = step(
          "deploy-staging",
          RESTORE,
          {},
          {
            PREVIOUS_API: "",
            PREVIOUS_AI: "",
            AI_DEPLOY: "failure",
            API_DEPLOY: "failure",
          },
        );

        expect(first.status, first.stderr).toBe(0);
        expect(first.created).toEqual([]);
        expect(first.stdout).toContain("::warning::");
      });

      it("runs only after a failure, as the last step", () => {
        const steps = stepsOf("deploy-staging");

        expect(steps[steps.length - 1].name).toBe(RESTORE);
        expect(steps[steps.length - 1].text).toMatch(
          /if: steps\.head\.outputs\.current == 'true' && steps\.dokploy\.outputs\.enabled == 'true' && failure\(\)/,
        );
      });
    });

    describe("the staged-<sha> marker", () => {
      it("is written for both images, on the deployed digests, after every deploy and check", () => {
        const names = stepsOf("deploy-staging").map((step) => step.name);
        const mark = names.indexOf("Mark this build as staged");

        for (const before of [
          "Deploy the AI service to staging (Dokploy)",
          "Deploy to staging (Dokploy)",
          "Wait for the API to serve this build",
          "Wait for the rollout to converge",
        ]) {
          expect(names.indexOf(before), before).toBeGreaterThan(-1);
          expect(names.indexOf(before), before).toBeLessThan(mark);
        }

        // No status function: it runs only when every step before it passed.
        expect(stepText("deploy-staging", "Mark this build as staged")).toMatch(
          /\n\s+if: steps\.head\.outputs\.current == 'true'\n/,
        );

        const result = step(
          "deploy-staging",
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

      it("lets the pull request pass once both images are staged on their sha-<sha> digests", () => {
        const result = step(
          "staging-image",
          "Wait for the staging deploy of the PR head",
          {
            "trajetto-api:sha-abcdef0": digest("1"),
            "trajetto-api:staged-abcdef0": digest("1"),
            "trajetto-ai:sha-abcdef0": digest("a"),
            "trajetto-ai:staged-abcdef0": digest("a"),
          },
          { HEAD_SHA: SHA },
        );

        expect(result.status, result.stderr).toBe(0);
      });

      it("keeps the pull request waiting, then fails it, while a marker is missing or on another digest", () => {
        // Every image built, one staged on another digest: it keeps asking
        // (two rounds here instead of 90, sleep stubbed), then fails with the
        // error that says what to do.
        expect(
          runBlock(
            "staging-image",
            "Wait for the staging deploy of the PR head",
          ),
        ).toContain("for attempt in $(seq 1 90); do");
        box.stub("seq", "printf '1\\n2\\n'");

        const result = step(
          "staging-image",
          "Wait for the staging deploy of the PR head",
          {
            "trajetto-api:sha-abcdef0": digest("1"),
            "trajetto-api:staged-abcdef0": digest("2"),
            "trajetto-ai:sha-abcdef0": digest("a"),
            "trajetto-ai:staged-abcdef0": digest("a"),
          },
          { HEAD_SHA: SHA },
        );

        expect(result.status).toBe(1);
        expect(result.stdout).toContain(
          "tentativa 2/90: ainda sem staged-abcdef0 em trajetto-api",
        );
        expect(result.stdout).not.toContain("em trajetto-api trajetto-ai");
        expect(result.stdout).toMatch(
          /::error::O commit abcdef0.* não tem o marcador staged-abcdef0/,
        );
      });

      describe("in the promote", () => {
        const CHECK = "Check that staging ran this build";
        const built = {
          "trajetto-api:sha-abcdef0": digest("1"),
          "trajetto-ai:sha-abcdef0": digest("a"),
        };

        it("is required on a merge, before anything is migrated or moved", () => {
          const names = stepsOf("promote-production").map((step) => step.name);

          expect(stepText("promote-production", CHECK)).toContain(
            "if: github.event_name == 'push'",
          );
          expect(names.indexOf(CHECK)).toBeGreaterThan(
            names.indexOf("Check the build exists in GHCR"),
          );
          expect(names.indexOf(CHECK)).toBeLessThan(
            names.indexOf("Run database migrations (once, before the rollout)"),
          );
          expect(names.indexOf(CHECK)).toBeLessThan(
            names.indexOf("Promote image to stable"),
          );
        });

        it("passes when staging ran exactly these digests", () => {
          const result = step(
            "promote-production",
            CHECK,
            {
              ...built,
              "trajetto-api:staged-abcdef0": digest("1"),
              "trajetto-ai:staged-abcdef0": digest("a"),
            },
            { IMAGE_TAG: "sha-abcdef0" },
          );

          expect(result.status, result.stderr).toBe(0);
        });

        it("refuses a build staging never ran, or a marker on another digest", () => {
          const missing = step(
            "promote-production",
            CHECK,
            {
              ...built,
              "trajetto-ai:staged-abcdef0": digest("a"),
            },
            { IMAGE_TAG: "sha-abcdef0" },
          );

          expect(missing.status).toBe(1);
          expect(missing.stdout).toMatch(
            /::error::trajetto-api:sha-abcdef0 existe no GHCR, mas o staging nunca rodou esse build/,
          );

          const other = step(
            "promote-production",
            CHECK,
            {
              ...built,
              "trajetto-api:staged-abcdef0": digest("1"),
              "trajetto-ai:staged-abcdef0": digest("b"),
            },
            { IMAGE_TAG: "sha-abcdef0" },
          );

          expect(other.status).toBe(1);
          expect(other.stdout).toMatch(
            /::error::.*trajetto-ai:staged-abcdef0 aponta para/,
          );
        });

        it("lets a build older than the AI service through on the API's marker alone", () => {
          const result = step(
            "promote-production",
            CHECK,
            {
              "trajetto-api:sha-abcdef0": digest("1"),
              "trajetto-api:staged-abcdef0": digest("1"),
            },
            { IMAGE_TAG: "sha-abcdef0" },
          );

          expect(result.status, result.stderr).toBe(0);
          expect(result.stdout).toContain(
            "::warning::trajetto-ai:sha-abcdef0 não existe",
          );
        });
      });
    });
  },
  30_000,
);
