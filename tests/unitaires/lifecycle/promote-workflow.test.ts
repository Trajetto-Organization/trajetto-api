import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hasShell, run, sandbox, type Sandbox } from "./support/shell-harness";

/**
 * The road to production: build once on staging, promote by digest.
 *
 * Every push to `staging` validates and builds the two images ONCE, as the
 * immutable `sha-<sha>`; the merge into `main` promotes the exact build
 * staging ran for the merged commit, never a rebuild; the manual button is
 * the rollback path, so it must ship exactly the build it is given — and
 * nothing else.
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

const workflow = read(".github", "workflows", "deploy.yml");

const dispatch = workflow.slice(
  workflow.indexOf("  workflow_dispatch:"),
  workflow.indexOf("\nenv:"),
);

const job = workflow.slice(workflow.indexOf("\n  promote-production:"));
const steps = job.split(/\n      - name: /).slice(1);
const index = (name: string) =>
  steps.findIndex((step) => step.startsWith(name));
const step = (name: string) => steps[index(name)] ?? "";

const jobOf = (name: string) => {
  const start = workflow.indexOf(`\n  ${name}:`);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[\w-]+:\n/);

  return start < 0 ? "" : next < 0 ? rest : rest.slice(0, next + 1);
};

/** The `run: |` block of the step called `name` inside `text`, dedented. */
function runBlock(text: string, name: string): string {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => line.trim() === `- name: ${name}`);

  if (at < 0) return "";

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

describe("the workflow's triggers", () => {
  it("runs on pushes to staging and main, on pull requests into main and by hand", () => {
    const on = workflow.slice(
      workflow.indexOf("\non:"),
      workflow.indexOf("\npermissions:"),
    );

    expect(on).toMatch(/push:\n {4}branches: \[staging, main\]/);
    expect(on).toMatch(/pull_request:\n {4}branches: \[main\]/);
    expect(on).toContain("workflow_dispatch:");
  });

  it("asks for nothing beyond reading the repository unless a job needs it", () => {
    expect(workflow).toMatch(/\npermissions:\n {2}contents: read\n/);

    for (const name of ["test", "ai-ocr", "secrets"]) {
      expect(jobOf(name), name).not.toContain("packages: write");
    }
  });
});

describe("the build (once, on staging)", () => {
  it("runs only on staging (a push, or Run workflow there), after the whole validation", () => {
    const build = jobOf("build-and-push");

    // Run workflow on staging is the staging road again (force_ai_build);
    // on main the same button is the promote, never a build.
    expect(build).toContain(
      "if: (github.event_name == 'push' || github.event_name == 'workflow_dispatch') && github.ref == 'refs/heads/staging'",
    );
    expect(build).toContain("needs: [test, ai-ocr, secrets]");
    expect(jobOf("promote-production")).toContain(
      "if: github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')",
    );
  });

  it("validates pull requests into main exactly as a push to staging", () => {
    for (const name of ["test", "ai-ocr", "secrets"]) {
      expect(jobOf(name), name).toContain(
        "if: github.event_name == 'pull_request' || github.ref == 'refs/heads/staging'",
      );
    }
  });

  it("never happens in the promote: production gets the bytes staging ran", () => {
    expect(jobOf("promote-production")).not.toMatch(
      /docker\/build-push-action|docker build\s/,
    );
  });

  it("publishes only the immutable sha-<sha>: the mutable tags are moved by digest", () => {
    const build = jobOf("build-and-push");
    const metadata = [...build.matchAll(/tags: \|\n((?: {12}.+\n)+)/g)].map(
      (m) => m[1].trim(),
    );

    // The API and the AI service (ADR 0010). Database backups are Dokploy's
    // own, so there is no backup image. The AI also carries `src-<tree>`,
    // the git hash of infra/ai-ocr: immutable too (it names the content the
    // image was built from), and how a later push finds it to reuse it.
    expect(metadata).toEqual([
      "type=sha,prefix=sha-",
      "type=sha,prefix=sha-\n            type=raw,value=src-${{ steps.ai-source.outputs.tree }}",
    ]);
    expect(build.match(/flavor: latest=false/g)).toHaveLength(2);
  });
});

describe("the tag given to the promote", () => {
  it("has no default: whoever presses the button names the build", () => {
    expect(dispatch).toContain("image_tag:");
    expect(dispatch).not.toMatch(/default:/);
  });

  it("is resolved, then validated first, before anything is migrated, retagged or deployed", () => {
    const resolveStep = index("Resolve the build to promote");
    const validate = index("Validate the tag to promote");

    expect(resolveStep, "passo de resolução").toBe(0);
    expect(validate, "passo de validação").toBe(1);
    expect(validate).toBeLessThan(index("Run database migrations"));
    expect(validate).toBeLessThan(index("Promote image to stable"));
    expect(validate).toBeLessThan(index("Deploy to production (Dokploy)"));
  });

  it("accepts only an immutable build", () => {
    const pattern = step("Validate the tag to promote").match(
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
    for (const each of steps) {
      const run = each.slice(
        each.indexOf("run:") >= 0 ? each.indexOf("run:") : each.length,
      );

      expect(run, each.split("\n")[0]).not.toContain("${{ inputs.image_tag }}");
      expect(run, each.split("\n")[0]).not.toContain(
        "${{ steps.target.outputs.tag }}",
      );
      expect(run, each.split("\n")[0]).not.toContain(
        "${{ steps.staged.outputs.tag }}",
      );
    }
  });

  it("is what `stable` moves to, and the digest is recorded", () => {
    const promote = step("Promote image to stable");

    // The build the staging check settled on (the commit's own, or the
    // documentation rule's), never the raw candidate.
    expect(promote).toContain("IMAGE_TAG: ${{ steps.staged.outputs.tag }}");
    expect(promote).toMatch(/trajetto-api:\$\{IMAGE_TAG\}/);
    expect(promote).toContain("GITHUB_STEP_SUMMARY");
  });

  it("fails clearly when the build does not exist, before anything moves", () => {
    const check = index("Check the build exists in GHCR");

    expect(check).toBeGreaterThan(index("Validate the tag to promote"));
    expect(check).toBeLessThan(index("Run database migrations"));
    expect(step("Check the build exists in GHCR")).toMatch(
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

      const script = box.file(
        "resolve.sh",
        runBlock(job, "Resolve the build to promote"),
      );
      const output = `${box.root}/output`;
      const summary = `${box.root}/summary`;

      writeFileSync(output, "");
      writeFileSync(summary, "");

      const result = run("bash", script, [], {
        bin: box.bin,
        env: {
          GITHUB_SHA: MERGE,
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
          REPO: "Trajetto-Organization/trajetto-api",
          INPUT_TAG: "",
          ...env,
        },
      });

      return { ...result, outputs: readFileSync(output, "utf8") };
    }

    it("takes the merge commit's second parent: the PR head staging built", () => {
      const result = resolveTag({ EVENT: "push" }, `${FIRST} ${HEAD}`);

      expect(result.status, result.stderr).toBe(0);
      // The full sha too: the staging check walks its history.
      expect(result.outputs).toBe(`tag=sha-abcdef0\ncommit=${HEAD}\n`);
      expect(box.calls("gh")[0]).toContain(
        `repos/Trajetto-Organization/trajetto-api/commits/${MERGE}`,
      );
    });

    it("takes the commit itself on a fast-forward", () => {
      const result = resolveTag({ EVENT: "push" }, FIRST);

      expect(result.status, result.stderr).toBe(0);
      expect(result.outputs).toBe(`tag=sha-fffffff\ncommit=${MERGE}\n`);
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
      expect(flaky.outputs).toBe(`tag=sha-abcdef0\ncommit=${HEAD}\n`);
      expect(flaky.stdout).toMatch(
        /::warning::A API do GitHub falhou .*tentativa 1 de 3/,
      );

      const down = resolveTag({ EVENT: "push" }, "", "exit 1");

      expect(down.status).toBe(1);
      expect(down.outputs).toBe("");
      expect(down.stdout).toMatch(/::error::A API do GitHub não respondeu/);
    });

    it("hands the typed tag over, and nothing that could forge another output", () => {
      expect(
        resolveTag({ EVENT: "workflow_dispatch", INPUT_TAG: "sha-0a1b2c3" })
          .outputs,
      ).toBe("tag=sha-0a1b2c3\n");
      expect(box.calls("gh")).toEqual([]);

      for (const typed of [
        "sha-0a1b2c3\ndigest=sha256:evil",
        "sha-0a1b2c3; id",
        "",
      ]) {
        expect(
          resolveTag({ EVENT: "workflow_dispatch", INPUT_TAG: typed }).outputs,
          typed,
        ).toBe("tag=invalid\n");
      }
    });
  },
);

describe("the deploy target (DEPLOY-1)", () => {
  it("is Dokploy, through the shared script, never the Portainer webhook", () => {
    expect(workflow).not.toMatch(/PORTAINER/);

    for (const job of ["deploy-staging", "promote-production"]) {
      const text = jobOf(job);

      expect(text, job).toContain(
        "run: node .github/scripts/dokploy-deploy.mjs",
      );
      // The script is in the repository, so the job checks it out.
      expect(text, job).toContain("sparse-checkout: .github/scripts");
      expect(text, job).toContain(
        "DOKPLOY_API_KEY: ${{ secrets.DOKPLOY_API_KEY }}",
      );
    }
  });

  it("deploys one Dokploy Application per service: AI, then API", () => {
    expect(workflow).not.toMatch(/compose.deploy|DOKPLOY_COMPOSE_ID/);
    // Backups are Dokploy's Database backups: no backup service ships here.
    expect(workflow).not.toMatch(
      /trajetto-backup|DOKPLOY_BACKUP_APPLICATION_ID/,
    );

    for (const [job, where] of [
      ["deploy-staging", "staging"],
      ["promote-production", "production"],
    ] as const) {
      const text = jobOf(job);
      const ai = text.indexOf(
        `- name: Deploy the AI service to ${where} (Dokploy)`,
      );
      const api = text.indexOf(`- name: Deploy to ${where} (Dokploy)`);
      const apiStep = text.slice(api, text.indexOf("- name:", api + 1));

      expect(ai, job).toBeGreaterThan(-1);
      expect(ai, job).toBeLessThan(api);
      expect(text, job).toContain(
        "DOKPLOY_APPLICATION_ID: ${{ secrets.DOKPLOY_AI_APPLICATION_ID }}",
      );
      expect(text, job).toContain(
        "DOKPLOY_APPLICATION_ID: ${{ secrets.DOKPLOY_API_APPLICATION_ID }}",
      );
      // The AI may not exist yet; the API may not be skipped.
      expect(text.slice(ai, api), job).toContain('DOKPLOY_OPTIONAL: "true"');
      expect(apiStep, job).toContain("DOKPLOY_APP_LABEL: trajetto-api");
      expect(apiStep, job).not.toContain("DOKPLOY_OPTIONAL");
    }
  });

  it("protects production with its own environment", () => {
    expect(jobOf("promote-production")).toContain("environment: production");
    expect(jobOf("deploy-staging")).toContain("environment: staging");
  });

  it("deploys production only after `stable` has moved", () => {
    expect(index("Promote image to stable")).toBeLessThan(
      index("Deploy to production (Dokploy)"),
    );
    // The AI service moves in the same job, before the deploy reads `stable`.
    expect(index("Promote the AI image to stable")).toBeGreaterThan(-1);
    expect(index("Promote the AI image to stable")).toBeLessThan(
      index("Deploy to production (Dokploy)"),
    );
  });

  it("moves staging to this run's digests, never to a tag", () => {
    const staging = jobOf("deploy-staging");

    expect(staging).toContain(
      '"ghcr.io/trajetto-organization/trajetto-api@${API_DIGEST}"',
    );
    expect(staging).toContain(
      '"ghcr.io/trajetto-organization/trajetto-ai@${AI_DIGEST}"',
    );
    expect(staging.indexOf("Move staging to this build")).toBeLessThan(
      staging.indexOf("Deploy to staging (Dokploy)"),
    );
  });

  it("releases only after production was promoted", () => {
    expect(jobOf("release")).toContain("needs: promote-production");
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
  };

  function configured(
    jobName: string,
    stepName: string,
    env: Record<string, string>,
  ) {
    const script = box.file(
      "configured.sh",
      runBlock(jobOf(jobName), stepName),
    );
    const output = `${box.root}/output`;

    writeFileSync(output, "");

    const result = run("bash", script, [], {
      env: {
        DOKPLOY_URL: "",
        DOKPLOY_API_KEY: "",
        DOKPLOY_API_APPLICATION_ID: "",
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: `${box.root}/summary`,
        ...env,
      },
    });

    return { ...result, outputs: readFileSync(output, "utf8") };
  }

  it.each([
    [
      "deploy-staging",
      "Is the staging deploy configured?",
      "Deploy to staging (Dokploy)",
    ],
    [
      "promote-production",
      "Is the production deploy configured?",
      "Deploy to production (Dokploy)",
    ],
  ])(
    "%s skips the deploy with a notice, deploys when configured, fails when half-configured",
    (jobName, stepName, deploy) => {
      const none = configured(jobName, stepName, {});

      expect(none.status, none.stderr).toBe(0);
      expect(none.outputs).toBe("enabled=false\n");
      expect(none.stdout).toContain("::notice::");

      const all = configured(jobName, stepName, SECRETS);

      expect(all.status).toBe(0);
      expect(all.outputs).toBe("enabled=true\n");
      expect(all.stdout + all.stderr).not.toContain("key-never-printed");

      const half = configured(jobName, stepName, {
        DOKPLOY_URL: SECRETS.DOKPLOY_URL,
      });

      expect(half.status).not.toBe(0);
      expect(half.stdout).toMatch(
        /::error::.*DOKPLOY_API_KEY DOKPLOY_API_APPLICATION_ID/,
      );

      // The deploy and its checks follow the answer. The staged marker does
      // not: before Dokploy exists the tags are all there is (as in the
      // web), and it still runs only after every step before it passed.
      const text = jobOf(jobName);
      const after = text.slice(text.indexOf(`- name: ${deploy}`));

      for (const chunk of after.split(/\n {6}- name: /)) {
        if (chunk.startsWith("Mark this build as staged")) continue;

        expect(chunk, chunk.split("\n")[0]).toMatch(
          /if: .*steps\.dokploy\.outputs\.enabled == 'true'/,
        );
      }
    },
  );
});

describe("the pull request into main", () => {
  it("waits for staging to have DEPLOYED its head, so the merge promotes a build staging ran", () => {
    const check = jobOf("staging-image");

    expect(check).toContain("if: github.event_name == 'pull_request'");
    expect(check).toContain(
      "HEAD_SHA: ${{ github.event.pull_request.head.sha }}",
    );
    // `sha-<sha>` exists as soon as the build pushed it, also when the scan
    // or the staging deploy failed afterwards: the marker is the proof, on
    // the same digest — the question staged-build.sh answers, for the PR
    // check and the promote alike (staged-build.test.ts).
    expect(check).toContain('bash .github/scripts/staged-build.sh "$HEAD_SHA"');
    expect(check).toContain("for attempt in $(seq 1 90); do");
    expect(check).toContain("packages: read");
    expect(check).not.toContain("packages: write");
    // The documentation rule compares the head with older commits: the PR
    // head itself, with its history.
    expect(check).toContain("ref: ${{ github.event.pull_request.head.sha }}");
    expect(check).toContain("fetch-depth: 0");
    // Branch protection requires the check by this name.
    expect(check).toContain("name: The PR head was built on staging");
  });
});

describe("a commit that only changes documentation (D11)", () => {
  it("is promoted with the build of the nearest commit staging ran, by the same rule as the PR check", () => {
    const check = step("Check that staging ran this build");

    expect(check).toContain("id: staged");
    expect(check).toContain("CANDIDATE: ${{ steps.target.outputs.commit }}");
    expect(check).toContain(
      'bash .github/scripts/staged-build.sh "$CANDIDATE"',
    );
    // The history it walks.
    expect(jobOf("promote-production")).toMatch(
      /- name: Checkout the deploy script\n\s+uses: [^\n]+\n\s+with:\n\s+fetch-depth: 0\n/,
    );
  });

  it("settles the build before anything reads it, and every later step uses that answer", () => {
    const staged = index("Check that staging ran this build");

    expect(staged).toBeGreaterThan(index("Validate the tag to promote"));
    expect(staged).toBeLessThan(index("Check the build exists in GHCR"));
    expect(staged).toBeLessThan(index("Run database migrations"));

    for (const each of steps.slice(staged + 1)) {
      expect(each, each.split("\n")[0]).not.toContain(
        "${{ steps.target.outputs.tag }}",
      );
    }

    for (const name of [
      "Check the build exists in GHCR",
      "Compare with what staging runs",
      "Run database migrations (once, before the rollout)",
      "Promote image to stable",
      "Promote the AI image to stable",
      "Wait for the API to serve the promoted build",
    ]) {
      expect(step(name), name).toContain(
        "IMAGE_TAG: ${{ steps.staged.outputs.tag }}",
      );
    }
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
  it("always moves `stable` to the build being promoted, under no condition", () => {
    const promote = step("Promote image to stable");

    expect(promote).not.toMatch(/\n\s+if:/);
    expect(promote).toContain('trajetto-api:${IMAGE_TAG}"');
    // Through ghcr.sh, which retries a GHCR hiccup instead of failing the
    // promote on it (ghcr-script.test.ts).
    expect(promote).toMatch(
      /bash \.github\/scripts\/ghcr\.sh tag \\\n\s+ghcr\.io\/trajetto-organization\/trajetto-api:stable \\\n/,
    );
  });
});
