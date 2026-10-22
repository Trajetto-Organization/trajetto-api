import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hasShell, run, sandbox, type Sandbox } from "./support/shell-harness";

/**
 * The road to production: build once on staging, promote by digest.
 *
 * Every push to `staging` validates and builds the three images ONCE, as the
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
  it("runs only on a push to staging, after the whole validation", () => {
    const build = jobOf("build-and-push");

    expect(build).toContain(
      "if: github.event_name == 'push' && github.ref == 'refs/heads/staging'",
    );
    expect(build).toContain("needs: [test, ai-ocr, secrets]");
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

    // The API, the backup sidecar and the AI service (ADR 0010).
    expect(metadata).toEqual([
      "type=sha,prefix=sha-",
      "type=sha,prefix=sha-",
      "type=sha,prefix=sha-",
    ]);
    expect(build.match(/flavor: latest=false/g)).toHaveLength(3);
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
    }
  });

  it("is what `stable` moves to, and the digest is recorded", () => {
    const promote = step("Promote image to stable");

    expect(promote).toContain("IMAGE_TAG: ${{ steps.target.outputs.tag }}");
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

    function resolveTag(env: Record<string, string>, parents = "") {
      box.stub("gh", `printf '%s\\n' "${parents}"`);

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
      expect(result.outputs).toBe("tag=sha-abcdef0\n");
      expect(box.calls("gh")[0]).toContain(
        `repos/Trajetto-Organization/trajetto-api/commits/${MERGE}`,
      );
    });

    it("takes the commit itself on a fast-forward", () => {
      const result = resolveTag({ EVENT: "push" }, FIRST);

      expect(result.status, result.stderr).toBe(0);
      expect(result.outputs).toBe("tag=sha-fffffff\n");
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

  it("deploys one Dokploy Application per service: AI, then API, then backup", () => {
    expect(workflow).not.toMatch(/compose.deploy|DOKPLOY_COMPOSE_ID/);

    for (const [job, where] of [
      ["deploy-staging", "staging"],
      ["promote-production", "production"],
    ] as const) {
      const text = jobOf(job);
      const ai = text.indexOf(
        `- name: Deploy the AI service to ${where} (Dokploy)`,
      );
      const api = text.indexOf(`- name: Deploy to ${where} (Dokploy)`);
      const backup = text.indexOf(
        `- name: Deploy the backup service to ${where} (Dokploy)`,
      );

      expect(ai, job).toBeGreaterThan(-1);
      expect(ai, job).toBeLessThan(api);
      expect(api, job).toBeLessThan(backup);
      expect(text, job).toContain(
        "DOKPLOY_APPLICATION_ID: ${{ secrets.DOKPLOY_AI_APPLICATION_ID }}",
      );
      expect(text, job).toContain(
        "DOKPLOY_APPLICATION_ID: ${{ secrets.DOKPLOY_API_APPLICATION_ID }}",
      );
      expect(text, job).toContain(
        "DOKPLOY_APPLICATION_ID: ${{ secrets.DOKPLOY_BACKUP_APPLICATION_ID }}",
      );
      // The AI and backup may not exist yet; the API may not be skipped.
      expect(text.slice(ai, api), job).toContain('DOKPLOY_OPTIONAL: "true"');
      expect(text.slice(api, backup), job).not.toContain("DOKPLOY_OPTIONAL");
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
      '"ghcr.io/trajetto-organization/trajetto-backup@${BACKUP_DIGEST}"',
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

      // The deploy and its checks follow the answer.
      const text = jobOf(jobName);
      const after = text.slice(text.indexOf(`- name: ${deploy}`));

      for (const chunk of after.split(/\n {6}- name: /)) {
        expect(chunk, chunk.split("\n")[0]).toMatch(
          /if: .*steps\.dokploy\.outputs\.enabled == 'true'/,
        );
      }
    },
  );
});

describe("the pull request into main", () => {
  it("waits for the staging images of its head, so the merge has something to promote", () => {
    const check = jobOf("staging-image");

    expect(check).toContain("if: github.event_name == 'pull_request'");
    expect(check).toContain(
      "HEAD_SHA: ${{ github.event.pull_request.head.sha }}",
    );
    expect(check).toContain('tag="sha-${HEAD_SHA::7}"');
    expect(check).toContain("packages: read");
    expect(check).not.toContain("packages: write");
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
    expect(promote).toContain(
      "--tag ghcr.io/trajetto-organization/trajetto-api:stable",
    );
  });
});
