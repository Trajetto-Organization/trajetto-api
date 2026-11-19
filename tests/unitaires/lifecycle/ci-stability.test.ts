import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runBlock } from "./support/run-block";
import { hasShell, sandbox, type Sandbox } from "./support/shell-harness";
import {
  allActions,
  allWorkflows,
  conditionOf,
  jobOf,
  needsOf,
  readAction,
  readWorkflow,
  stepNames,
  stepOf,
  timeoutOf,
  workflowOf,
} from "./support/workflow-text";

/**
 * A red pipeline means the code is wrong — never the network, a registry, a
 * moving tag or a step that hung (CI audit of 30/10/2026: runs that failed,
 * or passed, for reasons outside the code). What every workflow and every
 * composite action holds to, so none of those comes back:
 *
 * - every job has its own timeout (a hung step held the runner up to 6 h of
 *   a 2,000-minute month); a job that calls a reusable workflow cannot have
 *   one, and the jobs it calls do;
 * - every `run:` is `bash -eo pipefail` (GitHub's default for a step with no
 *   `shell:` has no pipefail: `git ls-remote | cut` failing handed an empty
 *   sha on, and the staging deploy was skipped, green);
 * - Node is the Dockerfile base's exact version, and every image a job pulls
 *   is pinned by digest, the same digest everywhere;
 * - the GitHub cache is an optimisation that never fails a build;
 * - GHCR is read only through ghcr.sh, which tells "not found" from "did not
 *   answer";
 * - the Prisma engines and Trivy's database are cached, and their download
 *   failing says so instead of failing (or passing) something else;
 * - a newer push cancels only a validation, never a build, a deploy or a
 *   release, and a push of documentation on staging cancels nothing;
 * - staging's road starts only on the staging branch;
 * - a job past one that runs over a skip (the Gate, validate.yml) states
 *   its own status check: the implicit success() would skip it;
 * - GHCR down fails only the jobs that cannot do without it;
 * - names are short statements, never questions (`?`), in every job and
 *   step.
 *
 * The `run:` blocks that decide are executed here, with the external
 * commands stubbed.
 */
const ROOT = process.cwd();
const workflows = allWorkflows();
const actions = allActions();
const ci = readWorkflow("ci.yml");
const validate = readWorkflow("validate.yml");
const staging = readWorkflow("staging.yml");
const pr = readWorkflow("pr.yml");
const production = readWorkflow("production.yml");
const setup = readAction("setup");
const deploy = readAction("deploy");
const siblings = readAction("siblings");

/** Every step of every job and of every action, with where it lives. */
const everyStep = [
  ...workflows.flatMap((workflow) =>
    workflow.jobs.flatMap((job) =>
      job.steps.map((step) => ({
        where: `${workflow.file} → ${job.name}`,
        step,
      })),
    ),
  ),
  ...actions.flatMap((action) =>
    action.steps.map((step) => ({ where: action.file, step })),
  ),
];

/** The Node version of the Dockerfile base: node:<x.y.z>-alpine… */
const dockerNode = /^FROM node:(\d+\.\d+\.\d+)-alpine/m.exec(
  readFileSync(resolve(ROOT, "Dockerfile"), "utf8"),
)?.[1];

describe("the workflows and actions", () => {
  it("has the files of the road to production to check", () => {
    expect(workflows.map((each) => each.file)).toEqual([
      "ci.yml",
      "cloudflare-ranges.yml",
      "pr.yml",
      "production.yml",
      "staging.yml",
      "validate.yml",
    ]);
    expect(actions.map((each) => each.name)).toEqual([
      "deploy",
      "setup",
      "siblings",
    ]);
  });

  it.each(workflows.map((each) => [each.file, each] as const))(
    "%s: every job that runs steps has its own timeout, with headroom and below GitHub's 6 h",
    (_, workflow) => {
      expect(workflow.jobs.length).toBeGreaterThan(0);

      for (const each of workflow.jobs) {
        const minutes = timeoutOf(each);

        // A job that calls a reusable workflow takes no timeout; the
        // workflow's own jobs carry theirs (checked in that file).
        if (each.uses) {
          expect(minutes, `${workflow.file} → ${each.name}`).toBeUndefined();
          expect(each.uses).toMatch(/^\.\/\.github\/workflows\/[\w-]+\.yml$/);
          continue;
        }

        expect(minutes, `${workflow.file} → ${each.name}`).toBeDefined();
        expect(minutes!, each.name).toBeGreaterThanOrEqual(5);
        expect(minutes!, each.name).toBeLessThanOrEqual(180);
      }
    },
  );

  it.each(workflows.map((each) => [each.file, each] as const))(
    "%s: runs every step with bash -eo pipefail",
    (_, workflow) => {
      expect(workflow.text).toMatch(/\ndefaults:\n {2}run:\n {4}shell: bash\n/);

      // No step opts out into another shell.
      for (const line of workflow.text.split("\n")) {
        if (/^\s+shell:/.test(line)) expect(line.trim()).toBe("shell: bash");
      }
    },
  );

  it.each(actions.map((each) => [each.file, each] as const))(
    "%s: names `shell: bash` in every run step (a composite action has no defaults)",
    (_, action) => {
      expect(action.text).toContain("\n  using: composite\n");

      const runs = action.steps.filter((step) => step.run);

      expect(runs.length).toBeGreaterThan(0);
      for (const step of runs) {
        expect(step.text, `${action.file} → ${step.name}`).toMatch(
          /\n {6}shell: bash\n/,
        );
      }
    },
  );

  it("keeps the timeouts that cover the measured worst case", () => {
    // The slowest E2E job measured on a 2-vCPU replica, about twice over;
    // the deploys cover six Dokploy attempts per service; the PR check
    // waits up to 45 min.
    expect(timeoutOf(jobOf(validate, "e2e"))).toBeGreaterThanOrEqual(25);
    expect(timeoutOf(jobOf(validate, "validate"))).toBeGreaterThanOrEqual(20);
    expect(timeoutOf(jobOf(staging, "deploy-staging"))).toBeGreaterThanOrEqual(
      120,
    );
    expect(
      timeoutOf(jobOf(production, "promote-production")),
    ).toBeGreaterThanOrEqual(120);
    expect(timeoutOf(jobOf(pr, "evidence"))).toBeGreaterThan(45);
  });
});

describe("the names", () => {
  // "Is this run still the branch head?" and the like were questions the
  // log answered with a green tick or a red cross: a name is a short
  // statement of what the job or step does, the same across the three
  // repositories when it is the same thing (docs/deploy.md).
  it("never ask: no job or step name has a question mark", () => {
    const names = [
      ...workflows.flatMap((workflow) =>
        [...workflow.text.matchAll(/^ +(?:- )?name: (.+)$/gm)].map(
          ([, name]) => `${workflow.file}: ${name}`,
        ),
      ),
      ...actions.flatMap((action) =>
        [...action.text.matchAll(/^ +(?:- )?name: (.+)$/gm)].map(
          ([, name]) => `${action.file}: ${name}`,
        ),
      ),
      ...workflows.map((workflow) => {
        const top = /^name: (.+)$/m.exec(workflow.text)?.[1] ?? "";

        return `${workflow.file}: ${top}`;
      }),
    ];

    expect(names.length).toBeGreaterThan(100);
    expect(names.filter((name) => name.includes("?"))).toEqual([]);
  });

  it("are the shared ones on the checks of the road to production", () => {
    const named = (workflow: typeof ci, job: string) =>
      /^ {4}name: (.+)$/m.exec(jobOf(workflow, job).text)?.[1];

    expect(named(ci, "changes")).toBe("Changes");
    expect(named(ci, "secrets")).toBe("Secret scan");
    expect(named(ci, "validate")).toBe("Validate");
    expect(named(validate, "validate")).toBe("Validate");
    expect(named(validate, "e2e")).toBe(
      "E2E (${{ matrix.shard }}/${{ strategy.job-total }})",
    );
    expect(named(validate, "ai-ocr")).toBe("AI OCR");
    expect(named(validate, "docs")).toBe("Docs");
    expect(named(staging, "changes")).toBe("Changes");
    expect(named(staging, "secrets")).toBe("Secret scan");
    expect(named(staging, "gate")).toBe("Gate");
    expect(named(staging, "build")).toBe("Build");
    expect(named(staging, "image-scan")).toBe("Image scan");
    expect(named(staging, "deploy-staging")).toBe("Deploy");
    // The two checks the main ruleset requires.
    expect(named(pr, "secrets")).toBe("Secret scan");
    expect(named(pr, "evidence")).toBe("Staging evidence");
    expect(named(production, "evidence")).toBe("Staging evidence");
    expect(named(production, "promote-production")).toBe("Deploy");
    expect(named(production, "release")).toBe("Release");
  });
});

describe.skipIf(!hasShell("bash"))("every run: block", () => {
  let box: Sandbox;

  beforeEach(() => {
    box = sandbox();
  });

  afterEach(() => box.dispose());

  it("is valid bash", () => {
    const broken: string[] = [];

    for (const { where, step } of everyStep) {
      if (!step.run) continue;

      // Expressions are filled in by GitHub before bash sees the script.
      const script = box.file(
        "syntax.sh",
        step.run.replace(/\$\{\{[^}]*\}\}/g, "x"),
      );
      const result = spawnSync("bash", ["-n", script], { encoding: "utf8" });

      if (result.status !== 0) {
        broken.push(`${where} → ${step.name}: ${result.stderr}`);
      }
    }

    expect(everyStep.filter(({ step }) => step.run).length).toBeGreaterThan(40);
    expect(broken).toEqual([]);
  });

  it("never has an expression of the composite actions' inputs inside the script", () => {
    // Inputs reach a script through `env`; `${{ inputs.x }}` inside `run:`
    // is pasted into the shell as code.
    for (const action of actions) {
      for (const step of action.steps) {
        expect(step.run, `${action.file} → ${step.name}`).not.toContain("${{");
      }
    }
  });
});

describe("pinned versions", () => {
  it("knows the Dockerfile base's Node version", () => {
    expect(dockerNode).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("sets up exactly that Node in every job that runs node, yarn or npx", () => {
    const values = [...workflows, ...actions].flatMap((each) =>
      [...each.text.matchAll(/node-version:\s*(\S+)/g)].map(
        ([, value]) => `${each.file}: ${value}`,
      ),
    );

    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      expect(value).toMatch(new RegExp(`: "${dockerNode}"$`));
    }

    // The two actions set Node up first.
    expect(setup.steps[0].text).toContain("uses: actions/setup-node@");
    expect(deploy.steps[0].text).toContain("uses: actions/setup-node@");

    for (const workflow of workflows) {
      for (const each of workflow.jobs) {
        const usesNode = each.steps.some((item) =>
          /(^|\n|&&\s*)\s*(node|yarn|npx)\s/.test(item.run),
        );

        if (!usesNode) continue;

        expect(
          each.steps.some(
            (item) =>
              item.text.includes("uses: actions/setup-node@") ||
              item.text.includes("uses: ./.github/actions/setup\n") ||
              /uses: \.\/\.github\/actions\/setup$/m.test(item.text),
          ),
          `${workflow.file} → ${each.name}`,
        ).toBe(true);
      }
    }
  });

  it("pins every image a job pulls by digest, the same digest everywhere", () => {
    const refs = [...workflows, ...actions].flatMap((each) =>
      [
        // services.*.image
        ...[...each.text.matchAll(/^\s+image:\s*(\S+)/gm)].map(([, ref]) => ({
          key: "image",
          ref,
        })),
        // POSTGRES_IMAGE, TRIVY_IMAGE…
        ...[...each.text.matchAll(/^\s+([A-Z_]+_IMAGE):\s*(\S+)/gm)].map(
          ([, key, ref]) => ({ key, ref }),
        ),
        // Buildx's BuildKit
        ...[...each.text.matchAll(/driver-opts:\s*image=(\S+)/g)].map(
          ([, ref]) => ({ key: "driver-opts", ref }),
        ),
        // `docker run` straight from a registry (gitleaks)
        ...[...each.text.matchAll(/^\s+(zricethezav\/\S+|aquasec\/\S+)/gm)].map(
          ([, ref]) => ({ key: "docker run", ref }),
        ),
      ]
        .map(({ key, ref }) => ({ file: each.file, key, ref }))
        // Our own images go by the digest the job just read (an expression),
        // or are the ones this job just built into the runner's Docker for
        // the smoke test (`trajetto-…:smoke`), which no registry has.
        .filter(
          ({ ref }) =>
            !ref.includes("${{") && !/^trajetto-[\w-]+:smoke$/.test(ref),
        ),
    );

    // The services, the smoke test's Postgres and Redis, Trivy, gitleaks
    // and BuildKit at least.
    expect(refs.length).toBeGreaterThanOrEqual(8);

    const digests = new Map<string, Set<string>>();

    for (const { file, ref } of refs) {
      expect(ref, `${file}: ${ref}`).toMatch(
        /^[\w./-]+:[\w.-]+@sha256:[0-9a-f]{64}$/,
      );

      const [name, digest] = ref.split("@");

      digests.set(name, (digests.get(name) ?? new Set()).add(digest));
    }

    for (const [name, set] of digests) {
      expect([...set], name).toHaveLength(1);
    }

    expect([...digests.keys()]).toEqual(
      expect.arrayContaining([
        "postgres:16-alpine",
        "redis:7-alpine",
        "moby/buildkit:v0.33.1",
        "aquasec/trivy:0.74.0",
        "zricethezav/gitleaks:v8.30.1",
      ]),
    );
  });

  it("pins BuildKit wherever Buildx is set up", () => {
    for (const { where, step } of everyStep) {
      if (!step.text.includes("uses: docker/setup-buildx-action@")) continue;

      expect(step.text, where).toMatch(
        /driver-opts: image=moby\/buildkit:v[\d.]+@sha256:[0-9a-f]{64}/,
      );
    }
  });
});

describe("the runner", () => {
  // ubuntu-latest began moving to 26.04 on 19/10/2026, with no commit of
  // ours; Playwright 1.56 refused it in the web's suites. Every job runs on
  // the same pinned image, bumped by hand in the three repositories.
  it("is a pinned Ubuntu in every job, never ubuntu-latest", () => {
    for (const { file, jobs } of workflows) {
      for (const job of jobs) {
        if (job.uses) continue;

        const runner = /\n {4}runs-on: (\S+)/.exec(job.text)?.[1];

        expect(runner, `${file} → ${job.name}`).toMatch(
          /^ubuntu-\d{2}\.\d{2}$/,
        );
      }
    }
  });
});

describe("the type-check", () => {
  // tsc holds about 2.3 GB live here; Node's default heap on a 7-8 GB
  // runner (a private repository's) is about 2 GB, and the check died with
  // "JavaScript heap out of memory" in a 7 GB Linux container (30/10/2026).
  it("gets a fixed heap with room over what tsc uses", () => {
    const step = stepOf(jobOf(validate, "validate"), "Type-check");
    const heap = Number(
      /NODE_OPTIONS: --max-old-space-size=(\d+)/.exec(step.text)?.[1],
    );

    expect(heap).toBeGreaterThanOrEqual(4096);
    expect(step.run).toContain("yarn typecheck");
  });
});

describe("caches", () => {
  it("never let the GitHub cache fail a build", () => {
    const exports = workflows.flatMap((workflow) =>
      [...workflow.text.matchAll(/cache-to:\s*(.+)/g)].map(([, value]) => ({
        file: workflow.file,
        value,
      })),
    );

    expect(exports.length).toBeGreaterThanOrEqual(3);
    for (const { file, value } of exports) {
      expect(value, file).toContain("ignore-error=true");
    }
  });

  it("cache the AI's test build, and the push reads that cache too", () => {
    const build = stepOf(
      jobOf(validate, "ai-ocr"),
      "Build the image and run its tests",
    ).text;

    expect(build).toContain("uses: docker/build-push-action@");
    expect(build).toContain("target: test");
    expect(build).toContain("cache-from: type=gha,scope=ai-test");
    expect(build).toContain(
      "cache-to: type=gha,mode=max,scope=ai-test,ignore-error=true",
    );

    const push = stepOf(
      jobOf(staging, "build"),
      "Build and push the AI image",
    ).text;

    expect(push).toContain("type=gha,scope=ai-test");
  });

  it("cache the Prisma engines by their version, before the install, in the one setup", () => {
    const names = stepNames(setup);
    const cache = stepOf(setup, "Cache the Prisma engines").text;

    expect(names.indexOf("Read the Prisma engines version")).toBeLessThan(
      names.indexOf("Cache the Prisma engines"),
    );
    expect(names.indexOf("Cache the Prisma engines")).toBeLessThan(
      names.indexOf("Install dependencies"),
    );
    expect(names.indexOf("Install dependencies")).toBeLessThan(
      names.indexOf("Check the Prisma schema engine"),
    );
    expect(cache).toContain("path: ~/.cache/prisma");
    expect(cache).toContain(
      "key: prisma-engines-${{ runner.os }}-${{ steps.prisma-engines.outputs.version }}",
    );
    expect(conditionOf(stepOf(setup, "Check the Prisma schema engine"))).toBe(
      "inputs.schema-engine == 'true'",
    );

    // The E2E migrates: its setup checks the engine, before the suite runs.
    const e2e = jobOf(validate, "e2e");
    const at = stepNames(e2e);

    expect(stepOf(e2e, "Set up dependencies").text).toMatch(
      /uses: \.\/\.github\/actions\/setup\n\s+with:\n\s+schema-engine: "true"/,
    );
    expect(at.indexOf("Set up dependencies")).toBeLessThan(
      at.indexOf("Run E2E tests"),
    );
  });

  it("install only through the setup action (the frozen lockfile, the same caches)", () => {
    for (const workflow of workflows) {
      for (const job of workflow.jobs) {
        for (const step of job.steps) {
          expect(
            step.run,
            `${workflow.file} → ${job.name} → ${step.name}`,
          ).not.toMatch(/yarn install/);
        }
      }
    }
  });
});

describe("GHCR", () => {
  it("is read and written only through ghcr.sh: no swallowed errors", () => {
    for (const { where, step } of everyStep) {
      expect(step.run, `${where} → ${step.name}`).not.toMatch(
        /docker buildx imagetools/,
      );
      expect(step.run, `${where} → ${step.name}`).not.toMatch(
        /2>\s*\/dev\/null\s*\|\|\s*true/,
      );
    }

    expect(staging.text).toContain("bash .github/scripts/ghcr.sh digest");
    expect(staging.text).toContain("bash .github/scripts/ghcr.sh tag");
    expect(deploy.text).toContain("bash .github/scripts/ghcr.sh digest");
    expect(deploy.text).toContain("bash .github/scripts/ghcr.sh tag");
  });

  it("is reachable by every job that calls a script or a local action: it checks the repository out first", () => {
    for (const workflow of workflows) {
      for (const each of workflow.jobs) {
        const at = each.steps.findIndex(
          (item) =>
            /bash \.github\/scripts\//.test(item.run) ||
            /uses: \.\/\.github\/actions\//.test(item.text),
        );

        if (at < 0) continue;

        expect(
          each.steps
            .slice(0, at)
            .some((item) => item.text.includes("uses: actions/checkout@")),
          `${workflow.file} → ${each.name}`,
        ).toBe(true);
      }
    }
  });

  it("the deploy jobs check out the action and the scripts it runs", () => {
    for (const [workflow, job] of [
      [staging, "deploy-staging"],
      [production, "promote-production"],
    ] as const) {
      const checkout = jobOf(workflow, job).steps[0].text;

      expect(checkout, job).toContain("uses: actions/checkout@");
      expect(checkout, job).toMatch(
        /sparse-checkout: \|\n\s+\.github\/actions\n\s+\.github\/scripts\n/,
      );
    }
  });
});

describe("cancelling", () => {
  /** Every concurrency block: where, its group and cancel-in-progress. */
  const blocks = workflows.flatMap((workflow) =>
    [
      ...workflow.text.matchAll(
        /\n( *)concurrency:\n\s+group: (.+)\n\s+cancel-in-progress: (.+)\n/g,
      ),
    ].map(([, indent, group, cancel]) => ({
      file: workflow.file,
      level: indent.length === 0 ? "workflow" : "job",
      group: group.trim(),
      cancel: cancel.trim(),
    })),
  );

  /** The group of staging's validation, as the expression picks it. */
  const STAGING_GROUP =
    "${{ needs.changes.outputs.docs == 'true' && format('staging-docs-{0}', github.run_id) || 'staging-validate' }}";

  const stagingGroup = (docs: boolean, runId: string) => {
    const [, docsFormat, codeGroup] =
      /^\$\{\{ needs\.changes\.outputs\.docs == 'true' && format\('([^']+)', github\.run_id\) \|\| '([^']+)' \}\}$/.exec(
        STAGING_GROUP,
      ) ?? [];

    return docs ? docsFormat.replace("{0}", runId) : codeGroup;
  };

  it("cancels only a superseded validation: a work branch, a pull request, staging's validation", () => {
    expect(
      blocks
        .filter((block) => block.cancel === "true")
        .map((block) => block.group),
    ).toEqual([
      "ci-${{ github.ref }}",
      "pr-${{ github.event.pull_request.number }}",
      STAGING_GROUP,
    ]);

    // staging's is on the job that calls validate.yml, never on the run:
    // the build and the deploy of a run that got that far always finish.
    expect(jobOf(staging, "validate").text).toContain(
      `\n    concurrency:\n      group: ${STAGING_GROUP}\n      cancel-in-progress: true\n`,
    );
    expect(staging.text).not.toMatch(/\nconcurrency:/);
    expect(production.text).not.toMatch(/\nconcurrency:/);
  });

  // A documentation push builds nothing, so the code run under it is the
  // one that deploys (the branch-head check lets it). In the code runs'
  // group it cancelled that validation, and staging stayed on an older
  // build with nothing red.
  it("lets a push of code cancel staging's validation, and a push of documentation cancel none", () => {
    expect(stagingGroup(false, "101")).toBe("staging-validate");
    expect(stagingGroup(false, "102")).toBe("staging-validate");
    expect(stagingGroup(true, "101")).not.toBe("staging-validate");
    expect(stagingGroup(true, "101")).not.toBe(stagingGroup(true, "102"));
  });

  it("runs one deploy per environment at a time, never cut midway", () => {
    expect(blocks.filter((block) => block.cancel === "false")).toEqual([
      {
        file: "production.yml",
        level: "job",
        group: "promote-production",
        cancel: "false",
      },
      {
        file: "staging.yml",
        level: "job",
        group: "deploy-staging",
        cancel: "false",
      },
    ]);
  });

  it("skips the Gate, instead of failing it, when a newer push cancelled the validation", () => {
    expect(jobOf(staging, "gate").text).toContain(
      "\n    if: ${{ github.ref == 'refs/heads/staging' && !cancelled() && !contains(needs.*.result, 'cancelled') }}\n",
    );
  });
});

describe("the staging road", () => {
  const ON_STAGING = "github.ref == 'refs/heads/staging'";

  /** A job's own `if:` (not one of its steps'), or "". */
  const jobIf = (job: (typeof staging.jobs)[number]) =>
    /^ {4}if: (.+)$/m.exec(job.text)?.[1] ?? "";

  // Run workflow takes any branch, and the form picks main (the default
  // branch): left there, or on a work branch, the road built that ref, ran
  // its migrations on staging's database and wrote `staged-<7>` and a
  // green Gate on a commit staging never had — the evidence a pull request
  // of that branch into main would accept.
  it("starts only on the staging branch: every job checks the ref or needs one that does", () => {
    const guarded = new Set<string>();

    for (const each of staging.jobs) {
      const condition = jobIf(each);
      const needs = needsOf(each.text);

      if (condition.includes(ON_STAGING)) {
        guarded.add(each.name);
      } else {
        // Skipped with what it needs (no `always()`/`!cancelled()`).
        expect(condition, each.name).not.toMatch(/always\(\)|cancelled\(\)/);
        expect(
          needs.some((name) => guarded.has(name)),
          `${each.name} precisa de um job que confere a branch`,
        ).toBe(true);
        guarded.add(each.name);
      }
    }

    // Where it publishes and deploys, it says so itself.
    for (const name of [
      "changes",
      "secrets",
      "gate",
      "build",
      "image-scan",
      "deploy-staging",
    ]) {
      expect(jobIf(jobOf(staging, name)), name).toContain(ON_STAGING);
    }
    expect(guarded.size).toBe(staging.jobs.length);
  });
});

/**
 * GitHub adds an implicit success() to a job's `if` without a status
 * function, and that success() sees every job upstream, not only `needs`: a
 * job skipped anywhere above skips this one, even past a job that ran
 * because of always() or !cancelled() (actions/runner#2205). The jobs inside
 * a reusable workflow count too, and validate.yml always skips some (Docs on
 * a push of code, the manual AI contract on staging). staging.yml's Build,
 * Image scan and Deploy, after a green Gate, were skipped that way on every
 * push. So a job past one that runs over a skip says `!cancelled()` itself,
 * and, since that alone would run it after a red Gate or a failed Build,
 * names the result (or an output) of every job it needs — the same rule
 * trajetto-ui and trajetto-mobile test.
 */
describe("a job downstream of one that runs past a skip", () => {
  const STATUS = /\b(?:always|cancelled|failure)\(\)/;
  const ownIf = (text: string) => /^ {4}if: (.+)$/m.exec(text)?.[1] ?? "";
  // Job keys are [\w-]+: nothing in them to escape.
  const cites = (job: string, need: string) =>
    new RegExp(`needs\\.${need}\\.(?:result|outputs)\\b`).test(job);

  /** The jobs past such a job, with what each one leaves unsaid. */
  function unstated(text: string): string[] {
    const jobs = new Map(
      workflowOf("", text).jobs.map((job) => [job.name, job.text] as const),
    );
    const ancestors = (key: string, seen = new Set<string>()) => {
      for (const parent of needsOf(jobs.get(key) ?? "")) {
        if (seen.has(parent)) continue;
        seen.add(parent);
        ancestors(parent, seen);
      }

      return seen;
    };
    // A job that may finish with something upstream of it, or inside it,
    // skipped: a status function in its own `if`, or a call of a reusable
    // workflow.
    const passesSkips = (key: string) => {
      const job = jobs.get(key) ?? "";

      return (
        STATUS.test(ownIf(job)) ||
        /\n {4}uses: \.\/\.github\/workflows\//.test(job)
      );
    };

    return [...jobs].flatMap(([key, job]) => {
      const past = [...ancestors(key)].filter(passesSkips);

      if (past.length === 0) return [];

      const missing = [
        ...(/!cancelled\(\)/.test(ownIf(job)) ? [] : ["!cancelled()"]),
        ...needsOf(job)
          .filter((need) => !cites(job, need))
          .map((need) => `needs.${need}`),
      ];

      return missing.length > 0
        ? [`${key} (after ${past.join(", ")}: ${missing.join(", ")})`]
        : [];
    });
  }

  it.each(workflows.map((workflow) => [workflow.file, workflow] as const))(
    "%s states it in every such job",
    (_, workflow) => {
      expect(unstated(workflow.text)).toEqual([]);
    },
  );

  it("catches staging.yml as it was", () => {
    const before = staging.text
      .replace(
        /\n {4}if: \$\{\{ !cancelled\(\) && github\.ref == 'refs\/heads\/staging' && needs\.gate\.result == 'success'[^\n]*\n/,
        "\n    if: github.ref == 'refs/heads/staging' && needs.changes.outputs.docs != 'true'\n",
      )
      .replace(
        /\n {4}if: \$\{\{ !cancelled\(\) && github\.ref == 'refs\/heads\/staging' && needs\.build\.result == 'success' \}\}\n/,
        "\n",
      )
      .replace(
        /\n {4}if: \$\{\{ !cancelled\(\) && github\.ref == 'refs\/heads\/staging' && needs\.build\.result == 'success' && needs\.image-scan\.result == 'success' \}\}\n/,
        "\n    if: github.ref == 'refs/heads/staging'\n",
      );

    expect(before).not.toBe(staging.text);
    expect(unstated(before)).toEqual([
      "build (after gate, validate: !cancelled(), needs.gate, needs.secrets)",
      "image-scan (after gate, validate: !cancelled())",
      "deploy-staging (after gate, validate: !cancelled(), needs.image-scan)",
    ]);
  });

  // !cancelled() alone runs the job after a red Gate: the Build of a commit
  // that failed its validation would publish an image.
  it("catches a job that says only !cancelled()", () => {
    const loose = staging.text.replace(
      / && needs\.gate\.result == 'success' && needs\.secrets\.result == 'success'/,
      "",
    );

    expect(loose).not.toBe(staging.text);
    expect(unstated(loose)).toEqual([
      "build (after gate, validate: needs.gate, needs.secrets)",
    ]);
  });
});

describe("what a push builds", () => {
  it("documentation only: the secret scan and Docs, no image", () => {
    for (const workflow of [ci, staging]) {
      const changes = jobOf(workflow, "changes");
      const classify = stepOf(changes, "Classify changes");

      expect(classify.run).toMatch(
        /^bash \.github\/scripts\/changes\.sh (branch|staging)$/,
      );
      expect(classify.text).toContain("BEFORE: ${{ github.event.before }}");
      expect(jobOf(workflow, "validate").text).toContain(
        "docs: ${{ needs.changes.outputs.docs == 'true' }}",
      );
    }

    expect(jobOf(staging, "build").text).toContain(
      "if: ${{ !cancelled() && github.ref == 'refs/heads/staging' && needs.gate.result == 'success' && needs.secrets.result == 'success' && needs.changes.outputs.docs != 'true' }}",
    );
    expect(jobOf(validate, "docs").text).toContain("if: ${{ inputs.docs }}");
    expect(stepOf(jobOf(validate, "docs"), "Unit tests").run).toBe(
      "yarn test --reporter=basic",
    );

    for (const job of ["validate", "e2e", "ai-ocr"]) {
      expect(jobOf(validate, job).text, job).toMatch(
        /\n {4}if: \$\{\{ !inputs\.docs( && inputs\.e2e)? \}\}\n/,
      );
    }
  });

  // `lint:check` is `prettier --check .`, which reads *.md and docs/ too: a
  // documentation push that skipped it turned the NEXT push of code red,
  // on a file that push never touched. And the documentation tests resolve
  // the links and ADRs a guide cites in the siblings, skipping themselves
  // without them.
  it("documentation only: Prettier and the siblings too, as in Validate", () => {
    for (const job of ["validate", "docs"]) {
      const each = jobOf(validate, job);
      const names = stepNames(each);

      expect(stepOf(each, "Check formatting").run, job).toBe("yarn lint:check");
      expect(
        stepOf(each, "Check out the web and the app next to this repository")
          .text,
        job,
      ).toContain(
        "uses: ./.github/actions/siblings\n        with:\n          token: ${{ secrets.CLIENT_REPOS_READ_TOKEN }}\n",
      );
      // Out of the workspace before the install, Prettier and tsc.
      expect(
        names.indexOf("Check out the web and the app next to this repository"),
        job,
      ).toBeLessThan(names.indexOf("Set up dependencies"));
    }

    expect(stepNames(siblings)).toEqual([
      "Check the sibling token",
      "Pick the sibling branches",
      "Check out the web next to this repository",
      "Check out the app next to this repository",
      "Move the web and the app beside this repository",
    ]);
  });

  it("runs the whole E2E suite on every push of code to staging, and on a work branch only on request", () => {
    expect(jobOf(staging, "validate").text).toContain("e2e: true");
    expect(jobOf(ci, "validate").text).toContain(
      "e2e: ${{ github.event_name == 'workflow_dispatch' && inputs.e2e == true }}",
    );
  });

  it("runs on every push, documentation included (the Docs job), with no paths filter", () => {
    for (const workflow of workflows) {
      expect(workflow.text, workflow.file).not.toMatch(/paths(-ignore)?:/);
    }
  });

  // The manual AI contract reads the same test environment as every other
  // job: one `env` block, in validate.yml, not a copy in ci.yml.
  it("runs the AI local contract only on ci.yml's Run workflow, under validate.yml's environment", () => {
    expect(jobOf(validate, "ai-local-e2e").text).toContain(
      "if: ${{ !inputs.docs && inputs.ai_local }}",
    );
    expect(jobOf(ci, "validate").text).toContain(
      "ai_local: ${{ github.event_name == 'workflow_dispatch' }}",
    );
    expect(jobOf(staging, "validate").text).not.toContain("ai_local");
    expect(ci.text).not.toMatch(/^env:/m);
    expect(validate.text).toMatch(/^env:\n {2}NODE_ENV: test\n/m);
  });
});

describe.skipIf(!hasShell("bash"))("the blocks that decide, run", () => {
  let box: Sandbox;

  beforeEach(() => {
    box = sandbox();
    box.stub("sleep", "exit 0");
  });

  afterEach(() => box.dispose());

  /**
   * A stub that answers each call with the next exit code of `codes` (the
   * last one repeats), and prints `out` on success.
   */
  function sequenced(name: string, codes: number[], out = "") {
    const counter = `${box.root}/${name}.count`;

    writeFileSync(counter, "0");
    box.stub(
      name,
      [
        `n=$(cat "${counter}")`,
        `echo $((n + 1)) > "${counter}"`,
        `set -- ${codes.join(" ")}`,
        'i=0; code=0; for c in "$@"; do code=$c; i=$((i + 1)); [ "$i" -gt "$n" ] && break; done',
        `[ "$code" -eq 0 ] && printf '%s\\n' "${out}"`,
        'exit "$code"',
      ].join("\n"),
    );
  }

  const exec = (
    script: string,
    env: Record<string, string> = {},
    cwd?: string,
  ) => runBlock(box, script, env, cwd);

  describe("the Gate", () => {
    const GATE = stepOf(jobOf(staging, "gate"), "Check results").run;
    const green = {
      CHANGES: "success",
      SECRETS: "success",
      VALIDATE: "true",
    };

    it("passes only when the classification, the scan and the whole validation passed", () => {
      const result = exec(GATE, green);

      expect(result.status, result.log).toBe(0);
      expect(result.summary).toContain("Gate:");
    });

    it.each([
      ["SECRETS", "failure", "Secret scan (failure)"],
      ["VALIDATE", "", "Validate (Validate / Result)"],
      ["VALIDATE", "false", "Validate (Validate / Result)"],
      ["CHANGES", "failure", "Changes (failure)"],
    ])("fails when %s is %o", (key, value, said) => {
      const result = exec(GATE, { ...green, [key]: value });

      expect(result.status).toBe(1);
      expect(result.log).toContain(`::error::O Gate não passa: ${said}`);
    });

    // The validation's verdict is validate.yml's own (its Result job), never
    // needs.validate.result: a job skipped inside the reusable workflow
    // leaks into the caller's result, and what it makes of it is not a
    // contract (validate.yml's header). A `success` there cannot pass a
    // Gate, and a `skipped` there cannot fail one.
    it("reads the validation's verdict from validate.yml's output, never from the caller's result", () => {
      const env = stepOf(jobOf(staging, "gate"), "Check results").text;

      expect(env).toContain("VALIDATE: ${{ needs.validate.outputs.passed }}");
      expect(validate.text).toContain("\n    outputs:\n      passed:\n");
      expect(validate.text).toContain(
        "        value: ${{ jobs.result.outputs.passed }}\n",
      );

      for (const workflow of workflows) {
        const callers = workflow.jobs
          .filter((job) => job.uses === "./.github/workflows/validate.yml")
          .map((job) => job.name);
        const code = workflow.text
          .split("\n")
          .filter((line) => !line.trim().startsWith("#"))
          .join("\n");

        for (const caller of callers) {
          expect(code, `${workflow.file}: ${caller}`).not.toContain(
            `needs.${caller}.result`,
          );
        }
      }
    });

    it("needs exactly those, and the Build needs it and the scan", () => {
      expect(jobOf(staging, "gate").text).toContain(
        "needs: [changes, secrets, validate]",
      );
      expect(jobOf(staging, "build").text).toContain(
        "needs: [changes, gate, secrets]",
      );
      expect(jobOf(staging, "image-scan").text).toContain("needs: build");
      expect(jobOf(staging, "deploy-staging").text).toContain(
        "needs: [build, image-scan]",
      );
    });
  });

  describe("the verdict of validate.yml (Result)", () => {
    const result = jobOf(validate, "result");
    const CHECK = stepOf(result, "Check results").run;
    // A push of code on staging: everything but Docs and the manual contract.
    const code = {
      DOCS: "false",
      WANT_E2E: "true",
      WANT_AI_LOCAL: "false",
      WANT_POSTGRES: "true",
      WANT_PGBOUNCER: "true",
      VALIDATE: "success",
      E2E: "success",
      AI_OCR: "success",
      POSTGRES_JOB: "success",
      PGBOUNCER_JOB: "success",
      DOCS_JOB: "skipped",
      AI_LOCAL: "skipped",
    };
    const docs = {
      ...code,
      DOCS: "true",
      VALIDATE: "skipped",
      E2E: "skipped",
      AI_OCR: "skipped",
      POSTGRES_JOB: "skipped",
      PGBOUNCER_JOB: "skipped",
      DOCS_JOB: "success",
    };

    // A job added to validate.yml and left out of `needs` would never be
    // judged: its red would not stop the Gate.
    it("judges every other job of the file, and runs past their skips", () => {
      const others = validate.jobs
        .map((job) => job.name)
        .filter((name) => name !== "result");

      // In file order, on one line or wrapped by Prettier.
      expect(needsOf(result.text)).toEqual(others);
      expect(result.text).toContain("\n    if: ${{ !cancelled() }}\n");
      expect(result.text).toContain(
        "\n    outputs:\n      passed: ${{ steps.check.outputs.passed }}\n",
      );
      for (const name of others) {
        expect(stepOf(result, "Check results").text, name).toContain(
          `\${{ needs.${name}.result }}`,
        );
      }
    });

    it.each([
      ["a push of code on staging", code],
      [
        "a work branch, without the E2E",
        { ...code, WANT_E2E: "false", E2E: "skipped" },
      ],
      [
        "Run workflow with the AI contract",
        { ...code, WANT_AI_LOCAL: "true", AI_LOCAL: "success" },
      ],
      [
        "a push that leaves infra/postgres alone (its image already published)",
        { ...code, WANT_POSTGRES: "false", POSTGRES_JOB: "skipped" },
      ],
      [
        "a push that leaves infra/pgbouncer alone (its image already published)",
        { ...code, WANT_PGBOUNCER: "false", PGBOUNCER_JOB: "skipped" },
      ],
      ["a push of documentation", docs],
    ])("passes %s", (_, env) => {
      const run = exec(CHECK, env);

      expect(run.status, run.log).toBe(0);
      expect(run.output).toBe("passed=true\n");
    });

    it.each([
      ["an E2E job failed", { ...code, E2E: "failure" }, "E2E (failure)"],
      [
        "the E2E did not run on staging",
        { ...code, E2E: "skipped" },
        "E2E (skipped)",
      ],
      [
        "Validate was skipped on code",
        { ...code, VALIDATE: "skipped" },
        "Validate (skipped)",
      ],
      ["AI OCR failed", { ...code, AI_OCR: "failure" }, "AI OCR (failure)"],
      [
        "the Postgres image failed its tests or its S3 proof",
        { ...code, POSTGRES_JOB: "failure" },
        "Postgres image (failure)",
      ],
      [
        "the Postgres image was asked for and skipped",
        { ...code, POSTGRES_JOB: "skipped" },
        "Postgres image (skipped)",
      ],
      [
        "the Postgres image ran on documentation",
        { ...docs, POSTGRES_JOB: "success" },
        "Postgres image (success)",
      ],
      [
        "the PgBouncer image failed its tests",
        { ...code, PGBOUNCER_JOB: "failure" },
        "PgBouncer image (failure)",
      ],
      [
        "the PgBouncer image was asked for and skipped",
        { ...code, PGBOUNCER_JOB: "skipped" },
        "PgBouncer image (skipped)",
      ],
      [
        "the PgBouncer image ran on documentation",
        { ...docs, PGBOUNCER_JOB: "success" },
        "PgBouncer image (success)",
      ],
      ["Docs ran on code", { ...code, DOCS_JOB: "success" }, "Docs (success)"],
      [
        "the AI contract was asked for and skipped",
        { ...code, WANT_AI_LOCAL: "true" },
        "AI local contract (skipped)",
      ],
      ["Docs failed", { ...docs, DOCS_JOB: "failure" }, "Docs (failure)"],
      [
        "Validate ran on documentation",
        { ...docs, VALIDATE: "success" },
        "Validate (success)",
      ],
      [
        "no result at all",
        { ...code, VALIDATE: "" },
        "Validate (sem resultado)",
      ],
    ])("fails when %s, naming it", (_, env, said) => {
      const run = exec(CHECK, env);

      expect(run.status).toBe(1);
      expect(run.log).toContain(
        "::error title=Result::A validação não passou:",
      );
      expect(run.log).toContain(said);
      expect(run.output).toBe("");
    });
  });

  describe("the branch-head check of the staging deploy", () => {
    const HEAD = stepOf(deploy, "Check run is branch head").run;
    const SHA = "abcdef0123456789abcdef0123456789abcdef01";
    const env = {
      GITHUB_REF: "refs/heads/staging",
      GITHUB_SHA: SHA,
      REQUIRED: "true",
    };

    it("is skipped where it is not required: production deploys what was approved", () => {
      box.stub("git", "exit 99");

      const result = exec(HEAD, { ...env, REQUIRED: "false" });

      expect(result.status, result.log).toBe(0);
      expect(result.output).toBe("current=true\n");
      expect(box.calls("git")).toEqual([]);
    });

    it("deploys when the read sha is this run's", () => {
      box.stub("git", `printf '%s\\trefs/heads/staging\\n' "${SHA}"`);

      const result = exec(HEAD, env);

      expect(result.status, result.log).toBe(0);
      expect(result.output).toBe("current=true\n");
    });

    it("tries a failed or empty read again, and only a valid sha decides", () => {
      // Failed, then empty, then the sha.
      box.stub(
        "git",
        [
          `n=$(cat "${box.root}/n" 2>/dev/null || echo 0); echo $((n + 1)) > "${box.root}/n"`,
          '[ "$n" -eq 0 ] && exit 128',
          '[ "$n" -eq 1 ] && exit 0',
          `printf '%s\\trefs/heads/staging\\n' "${SHA}"`,
        ].join("\n"),
      );

      const result = exec(HEAD, env);

      expect(result.status, result.log).toBe(0);
      expect(result.output).toBe("current=true\n");
      expect(result.log.match(/::warning::A leitura da cabeça/g)).toHaveLength(
        2,
      );
    });

    it("fails, instead of skipping the deploy green, when GitHub never answers", () => {
      box.stub("git", "exit 128");

      const result = exec(HEAD, env);

      expect(result.status).toBe(1);
      expect(result.output).toBe("");
      expect(result.log).toMatch(/::error::Não deu para ler a cabeça/);
      expect(box.calls("git")).toHaveLength(3);
    });

    interface NewerHead {
      ancestor?: number;
      fetch?: number[];
    }

    /**
     * git with a newer head: ls-remote answers it, fetch exits `fetch`
     * (a list of codes, the last one repeating), merge-base --is-ancestor
     * exits `ancestor`, and the diff docs-only.sh reads lists `changed`.
     */
    function newerHead(changed: string[], options: NewerHead = {}) {
      const { ancestor = 0, fetch = [0] } = options;
      const counter = `${box.root}/fetch.count`;

      writeFileSync(counter, "0");
      box.stub(
        "git",
        [
          'case "$1" in',
          `  ls-remote) printf '%s\\trefs/heads/staging\\n' "${"f".repeat(40)}" ;;`,
          "  fetch)",
          `    n=$(cat "${counter}"); echo $((n + 1)) > "${counter}"`,
          `    set -- ${fetch.join(" ")}`,
          '    i=0; code=0; for c in "$@"; do code=$c; i=$((i + 1)); [ "$i" -gt "$n" ] && break; done',
          '    exit "$code" ;;',
          `  merge-base) exit ${ancestor} ;;`,
          // docs-only.sh: git -c core.quotePath=false diff --no-renames …
          `  -c) printf '%b' "${changed.map((path) => `${path}\\n`).join("")}" ;;`,
          "  *) exit 99 ;;",
          "esac",
        ].join("\n"),
      );
    }

    // docs-only.sh is read from the workspace, as in the job.
    const runHead = () => exec(HEAD, env, ROOT);

    it("leaves staging to a newer run that changes code, green", () => {
      newerHead(["docs/deploy.md", "src/server.ts"]);

      const result = runHead();

      expect(result.status, result.log).toBe(0);
      expect(result.output).toBe("current=false\n");
      expect(result.log).toMatch(
        /::notice::staging já está em f{40}: este run/,
      );
    });

    it("deploys anyway when the newer head only adds documentation (a documentation push builds nothing)", () => {
      newerHead(["docs/deploy.md", "README.md", "infra/traefik/README.md"]);

      const result = runHead();

      expect(result.status, result.log).toBe(0);
      expect(result.output).toBe("current=true\n");
      expect(result.log).toMatch(/só acrescenta documentação a este build/);
      expect(
        box.calls("git").some((call) => call.includes("diff --no-renames")),
      ).toBe(true);
    });

    it("leaves staging alone when the newer head does not descend from this commit", () => {
      newerHead(["docs/deploy.md"], { ancestor: 1 });

      const result = runHead();

      expect(result.status, result.log).toBe(0);
      expect(result.output).toBe("current=false\n");
      // Not a descendant: nothing to compare.
      expect(box.calls("git").some((call) => call.includes("diff"))).toBe(
        false,
      );
    });

    it("tries the fetch of the newer head again, then decides", () => {
      newerHead(["README.md"], { fetch: [128, 0] });

      const result = runHead();

      expect(result.status, result.log).toBe(0);
      expect(result.output).toBe("current=true\n");
      expect(
        result.log.match(/::warning::A busca de f{40} falhou/g),
      ).toHaveLength(1);
    });

    it("fails, instead of guessing, when the newer head cannot be fetched", () => {
      newerHead(["README.md"], { fetch: [128] });

      const result = runHead();

      expect(result.status).toBe(1);
      expect(result.output).toBe("");
      expect(result.log).toMatch(/::error::Não deu para buscar f{40}/);
      expect(
        box.calls("git").filter((call) => call.startsWith("git fetch")),
      ).toHaveLength(3);
    });

    it("fails when git cannot tell whether the head descends from this commit", () => {
      newerHead(["README.md"], { ancestor: 128 });

      const result = runHead();

      expect(result.status).toBe(1);
      expect(result.output).toBe("");
      expect(result.log).toMatch(/::error::git merge-base não comparou/);
    });

    it("comes first, and every later step of the deploy waits on its answer", () => {
      const names = stepNames(deploy);
      const head = names.indexOf("Check run is branch head");

      expect(head).toBe(1);
      for (const step of deploy.steps.slice(head + 1)) {
        expect(conditionOf(step), step.name).toMatch(
          /^steps\.head\.outputs\.current == 'true'( &&|$)/,
        );
      }
      expect(jobOf(staging, "deploy-staging").text).toContain(
        'require-branch-head: "true"',
      );
      expect(jobOf(production, "promote-production").text).toContain(
        'require-branch-head: "false"',
      );
    });
  });

  describe("the Prisma engines", () => {
    it("are keyed by the engines version yarn.lock resolves", () => {
      const result = exec(stepOf(setup, "Read the Prisma engines version").run);
      const lock = readFileSync(resolve(ROOT, "yarn.lock"), "utf8").replace(
        /\r\n/g,
        "\n",
      );
      const version =
        /^"?@prisma\/engines-version@[^\n]*:\n {2}version "([^"]+)"/m.exec(
          lock,
        )?.[1];

      expect(result.status, result.log).toBe(0);
      expect(version).toBeTruthy();
      expect(result.output).toBe(`version=${version}\n`);
    });

    const CHECK = stepOf(setup, "Check the Prisma schema engine").run;

    function tree(engine: boolean, postinstallDownloads: boolean) {
      if (engine) {
        box.file(
          "node_modules/@prisma/engines/schema-engine-debian-openssl-3.0.x",
          "x",
        );
      }
      box.file(
        "node_modules/@prisma/engines/scripts/postinstall.js",
        postinstallDownloads
          ? 'require("fs").writeFileSync(__dirname + "/../schema-engine-debian-openssl-3.0.x", "x");'
          : "// the download failed, silently (failSilent)",
      );
    }

    it("pass at once when the install left the engine", () => {
      tree(true, false);

      const result = exec(CHECK, {}, box.root);

      expect(result.status, result.log).toBe(0);
      expect(result.log).not.toContain("::warning::");
    });

    it("are downloaded again when the postinstall left nothing, with a warning", () => {
      tree(false, true);

      const result = exec(CHECK, {}, box.root);

      expect(result.status, result.log).toBe(0);
      expect(result.log).toMatch(/::warning::O schema engine do Prisma/);
      expect(
        existsSync(
          `${box.root}/node_modules/@prisma/engines/schema-engine-debian-openssl-3.0.x`,
        ),
      ).toBe(true);
    });

    it("stop the job with the cause when the download keeps failing", () => {
      tree(false, false);

      const result = exec(CHECK, {}, box.root);

      expect(result.status).toBe(1);
      expect(result.log).toMatch(
        /::error::O schema engine do Prisma não foi baixado/,
      );
    });
  });

  describe("the AI pytest, skipped for a source that already passed it", () => {
    const LOOKUP = stepOf(
      jobOf(validate, "ai-ocr"),
      "Look up the AI image for this source",
    ).run;
    const TREE = "1234567890abcdef1234567890abcdef12345678";

    beforeEach(() => {
      box.stub("git", `printf '%s\\n' "${TREE}"`);
      box.file(".github/scripts/ghcr.sh", 'exec sh "$STUB_GHCR" "$@"\n');
    });

    const lookup = (ghcr: string, force = "false", loggedIn = "true") => {
      const stub = box.file("ghcr-stub.sh", ghcr);

      return exec(
        LOOKUP,
        { FORCE: force, LOGGED_IN: loggedIn, STUB_GHCR: stub },
        box.root,
      );
    };

    it("ends the job when an image of the same infra/ai-ocr exists", () => {
      const result = lookup(`printf 'sha256:${"a".repeat(64)}\\n'`);

      expect(result.status, result.log).toBe(0);
      expect(result.output).toBe("test=false\n");
      expect(result.summary).toContain("já passou no pytest");
    });

    it("tests when there is none, when GHCR does not answer, or when forced", () => {
      expect(lookup("exit 0").output).toBe("test=true\n");

      const down = lookup("exit 1");

      expect(down.status, down.log).toBe(0);
      expect(down.output).toBe("test=true\n");
      expect(down.log).toMatch(/::warning::O GHCR não respondeu/);

      expect(
        lookup(`printf 'sha256:${"a".repeat(64)}\\n'`, "true").output,
      ).toBe("test=true\n");
    });

    // The login used to be docker/login-action: GHCR down failed the job
    // there, and the fallback above never ran — on a work branch, whose
    // AI job used not to talk to GHCR at all.
    it("tests, without asking GHCR, when the login to it failed", () => {
      const result = lookup(
        `printf 'sha256:${"a".repeat(64)}\\n'`,
        "false",
        "false",
      );

      expect(result.status, result.log).toBe(0);
      expect(result.output).toBe("test=true\n");
      expect(result.log).toMatch(/::warning::Sem login no GHCR/);
    });

    it("logs in through ghcr.sh, which retries, and never fails the job on it", () => {
      for (const [workflow, job, key] of [
        [validate, "ai-ocr", "ok"],
        [staging, "changes", "login"],
      ] as const) {
        const login = stepOf(
          jobOf(workflow, job),
          "Log in to GitHub Container Registry",
        );

        expect(login.text, job).not.toContain("docker/login-action");
        expect(login.text, job).toContain("id: ghcr");
        expect(login.run, job).toMatch(
          /^if bash \.github\/scripts\/ghcr\.sh login; then\n/,
        );

        const up = box.file("ghcr-up.sh", "exit 0\n");
        const gone = box.file("ghcr-down.sh", "exit 1\n");
        const ok = exec(login.run, { STUB_GHCR: up }, box.root);
        const down = exec(login.run, { STUB_GHCR: gone }, box.root);

        expect(ok.status, ok.log).toBe(0);
        expect(down.status, down.log).toBe(0);
        expect(ok.outputs[key], job).toBe(key === "ok" ? "true" : "ok");
        expect(down.outputs[key], job).toBe(key === "ok" ? "false" : "failed");
      }
      expect(
        stepOf(jobOf(staging, "changes"), "Classify changes").text,
      ).toContain("GHCR_LOGIN: ${{ steps.ghcr.outputs.login }}");
    });

    it("builds and tests only on that answer", () => {
      const job = jobOf(validate, "ai-ocr");

      for (const name of [
        "Set up Docker Buildx",
        "Build the image and run its tests",
      ]) {
        expect(conditionOf(stepOf(job, name)), name).toBe(
          "steps.ai-source.outputs.test == 'true'",
        );
      }
      expect(job.text).toContain("packages: read");
      expect(jobOf(staging, "validate").text).toContain(
        "force_ai: ${{ inputs.force_ai_build == true }}",
      );
    });
  });

  // The trajetto-postgres image (plano-escala F1-03): tested and proven on
  // S3 only for an infra/postgres with no published image, and not even
  // started otherwise (changes.sh), so CI stays within its minutes.
  describe("the Postgres image, tested only for a new infra/postgres", () => {
    const job = jobOf(validate, "postgres-image");
    const LOOKUP = stepOf(
      job,
      "Look up the Postgres image for this source",
    ).run;
    const TREE = "fedcba0987654321fedcba0987654321fedcba09";

    beforeEach(() => {
      box.stub("git", `printf '%s\\n' "${TREE}"`);
      box.file(".github/scripts/ghcr.sh", 'exec sh "$STUB_GHCR" "$@"\n');
    });

    const lookup = (ghcr: string, loggedIn = "true") =>
      exec(
        LOOKUP,
        { LOGGED_IN: loggedIn, STUB_GHCR: box.file("ghcr-stub.sh", ghcr) },
        box.root,
      );

    it("ends the job when an image of the same infra/postgres exists", () => {
      const result = lookup(`printf 'sha256:${"b".repeat(64)}\\n'`);

      expect(result.status, result.log).toBe(0);
      expect(result.output).toBe("test=false\n");
      expect(result.summary).toContain(`src-${TREE.slice(0, 12)}`);
    });

    it("tests when there is none, when GHCR does not answer, or without a login", () => {
      expect(lookup("exit 0").output).toBe("test=true\n");

      const down = lookup("exit 1");

      expect(down.status, down.log).toBe(0);
      expect(down.output).toBe("test=true\n");
      expect(down.log).toMatch(/::warning::O GHCR não respondeu/);

      const noLogin = lookup(`printf 'sha256:${"b".repeat(64)}\\n'`, "false");

      expect(noLogin.output).toBe("test=true\n");
      expect(noLogin.log).toMatch(/::warning::Sem login no GHCR/);
    });

    it("runs only when asked, and builds, tests and proves only on the lookup's answer", () => {
      expect(job.text).toContain(
        "\n    if: ${{ !inputs.docs && inputs.postgres }}\n",
      );
      expect(timeoutOf(job)).toBeGreaterThanOrEqual(15);
      expect(job.text).toContain("packages: read");
      for (const name of [
        "Set up Docker Buildx",
        "Build the image and run its tests",
        "Build the image for the S3 proof",
        "Prove the image against S3 (MinIO)",
      ]) {
        expect(conditionOf(stepOf(job, name)), name).toBe(
          "steps.postgres-source.outputs.test == 'true'",
        );
      }
      const test = stepOf(job, "Build the image and run its tests").text;

      expect(test).toContain("context: ./infra/postgres");
      expect(test).toContain("target: test");
      expect(test).toContain("cache-from: type=gha,scope=postgres-test");
      expect(stepOf(job, "Prove the image against S3 (MinIO)").run).toContain(
        "bash infra/postgres/test/s3-proof.sh trajetto-postgres:proof",
      );
      // The S3 server is pinned by digest like every image a job pulls.
      expect(stepOf(job, "Prove the image against S3 (MinIO)").text).toMatch(
        /MINIO_IMAGE: pgsty\/minio:[\w.-]+@sha256:[0-9a-f]{64}/,
      );
    });

    it("takes changes.sh's answer in both workflows, running when it is missing", () => {
      for (const workflow of [ci, staging]) {
        expect(jobOf(workflow, "changes").text, workflow.file).toContain(
          "postgres: ${{ steps.changes.outputs.postgres }}",
        );
        expect(jobOf(workflow, "validate").text, workflow.file).toContain(
          "postgres: ${{ needs.changes.outputs.postgres != 'false' }}",
        );
      }
      expect(validate.text).toMatch(
        /\n {6}postgres:\n {8}description: .+\n {8}type: boolean\n {8}default: true\n/,
      );
    });
  });

  // The trajetto-pgbouncer image (plano-escala F4-35): its `test` stage
  // (the real PgBouncer, offline, every value read back) only for an
  // infra/pgbouncer with no published image, as the Database's.
  describe("the PgBouncer image, tested only for a new infra/pgbouncer", () => {
    const job = jobOf(validate, "pgbouncer-image");
    const LOOKUP = stepOf(
      job,
      "Look up the PgBouncer image for this source",
    ).run;
    const TREE = "0123456789abcdef0123456789abcdef01234567";

    beforeEach(() => {
      box.stub("git", `printf '%s\\n' "${TREE}"`);
      box.file(".github/scripts/ghcr.sh", 'exec sh "$STUB_GHCR" "$@"\n');
    });

    const lookup = (ghcr: string, loggedIn = "true") =>
      exec(
        LOOKUP,
        { LOGGED_IN: loggedIn, STUB_GHCR: box.file("ghcr-stub.sh", ghcr) },
        box.root,
      );

    it("ends the job when an image of the same infra/pgbouncer exists", () => {
      const result = lookup(`printf 'sha256:${"c".repeat(64)}\\n'`);

      expect(result.status, result.log).toBe(0);
      expect(result.output).toBe("test=false\n");
      expect(result.summary).toContain(
        `trajetto-pgbouncer: infra/pgbouncer igual ao de src-${TREE.slice(0, 12)}`,
      );
    });

    it("tests when there is none, when GHCR does not answer, or without a login", () => {
      expect(lookup("exit 0").output).toBe("test=true\n");

      const down = lookup("exit 1");

      expect(down.status, down.log).toBe(0);
      expect(down.output).toBe("test=true\n");
      expect(down.log).toMatch(
        /::warning::O GHCR não respondeu sobre trajetto-pgbouncer/,
      );

      const noLogin = lookup(`printf 'sha256:${"c".repeat(64)}\\n'`, "false");

      expect(noLogin.output).toBe("test=true\n");
      expect(noLogin.log).toMatch(/::warning::Sem login no GHCR/);
    });

    it("runs only when asked, and builds and tests only on the lookup's answer", () => {
      expect(job.text).toContain(
        "\n    if: ${{ !inputs.docs && inputs.pgbouncer }}\n",
      );
      expect(timeoutOf(job)).toBeGreaterThanOrEqual(10);
      expect(job.text).toContain("packages: read");
      for (const name of [
        "Set up Docker Buildx",
        "Build the image and run its tests",
      ]) {
        expect(conditionOf(stepOf(job, name)), name).toBe(
          "steps.pgbouncer-source.outputs.test == 'true'",
        );
      }
      const test = stepOf(job, "Build the image and run its tests").text;

      expect(test).toContain("context: ./infra/pgbouncer");
      expect(test).toContain("target: test");
      expect(test).toContain("push: false");
      // Its own scope, which the staging Build reads back.
      expect(test).toContain("cache-from: type=gha,scope=pgbouncer-test");
      expect(test).toContain(
        "cache-to: type=gha,mode=max,scope=pgbouncer-test,ignore-error=true",
      );
    });

    it("takes changes.sh's answer in both workflows, running when it is missing", () => {
      for (const workflow of [ci, staging]) {
        expect(jobOf(workflow, "changes").text, workflow.file).toContain(
          "pgbouncer: ${{ steps.changes.outputs.pgbouncer }}",
        );
        expect(jobOf(workflow, "validate").text, workflow.file).toContain(
          "pgbouncer: ${{ needs.changes.outputs.pgbouncer != 'false' }}",
        );
      }
      expect(validate.text).toMatch(
        /\n {6}pgbouncer:\n {8}description: .+\n {8}type: boolean\n {8}default: true\n/,
      );
    });
  });

  describe("Trivy's vulnerability database", () => {
    const DOWNLOAD = stepOf(
      jobOf(staging, "image-scan"),
      "Download the vulnerability database",
    ).run;

    it("is downloaded once, into the cached directory, as the runner's user", () => {
      sequenced("docker", [0]);

      const result = exec(DOWNLOAD, {
        HOME: box.root,
        TRIVY_IMAGE: "aquasec/trivy:0@sha256:x",
      });

      expect(result.status, result.log).toBe(0);
      expect(result.output).toBe("db=fresh\n");

      const [call] = box.calls("docker");

      expect(call).toContain("--download-db-only");
      // $HOME/.cache/trivy (Git Bash spells the same directory its own way).
      expect(call).toMatch(/ -v \S+\/\.cache\/trivy:\/trivy-cache /);
      expect(call).toMatch(/--user \d+:\d+/);
    });

    it("falls back to the cached copy when the download keeps failing, and says so", () => {
      sequenced("docker", [1, 1, 1]);
      const db = box.file(".cache/trivy/db/trivy.db", "db");

      utimesSync(
        db,
        new Date("2026-10-29T12:00:00Z"),
        new Date("2026-10-29T12:00:00Z"),
      );

      const result = exec(DOWNLOAD, {
        HOME: box.root,
        TRIVY_IMAGE: "aquasec/trivy:0@sha256:x",
      });

      expect(result.status, result.log).toBe(0);
      expect(result.output).toBe("db=cached\n");
      expect(box.calls("docker")).toHaveLength(3);
      expect(result.log).toMatch(
        /::warning::Trivy: falha no download do banco.*2026-10-29/,
      );
      expect(result.summary).toContain("falha no download do banco");
    });

    it("never fails the job when there is no database at all: the scan is skipped, loudly", () => {
      sequenced("docker", [1, 1, 1]);

      const result = exec(DOWNLOAD, {
        HOME: box.root,
        TRIVY_IMAGE: "aquasec/trivy:0@sha256:x",
      });

      expect(result.status, result.log).toBe(0);
      expect(result.output).toBe("db=missing\n");
      expect(result.summary).toContain("o scan não rodou");
    });
  });

  describe("the image scan", () => {
    const SCAN = stepOf(jobOf(staging, "image-scan"), "Scan the images");

    const env = (enforce: boolean, db = "fresh") => ({
      HOME: box.root,
      TRIVY_IMAGE: "aquasec/trivy:0@sha256:x",
      API_IMAGE: `ghcr.io/trajetto-organization/trajetto-api@sha256:${"1".repeat(64)}`,
      MIGRATE_IMAGE: `ghcr.io/trajetto-organization/trajetto-api-migrate@sha256:${"2".repeat(64)}`,
      AI_IMAGE: `ghcr.io/trajetto-organization/trajetto-ai@sha256:${"a".repeat(64)}`,
      ENFORCE: enforce ? "true" : "false",
      DB: db,
    });

    it("has no continue-on-error left to hide a broken scan, and reads the images the Build pushed", () => {
      expect(SCAN.text).not.toContain("continue-on-error");
      expect(SCAN.text).toContain(
        "ENFORCE: ${{ vars.IMAGE_SCAN_ENFORCE == 'true' }}",
      );
      expect(SCAN.run).toContain("--skip-db-update");
      expect(SCAN.run).toContain("--exit-code 3");
      for (const output of ["api_digest", "migrate_digest", "ai_digest"]) {
        expect(SCAN.text).toContain(`@\${{ needs.build.outputs.${output} }}`);
      }
    });

    it("passes clean images and writes each verdict in the summary", () => {
      sequenced("docker", [0]);

      const result = exec(SCAN.run, env(true));

      expect(result.status, result.log).toBe(0);
      expect(result.summary).toContain("trajetto-api sem CRITICAL corrigível");
      expect(result.summary).toContain(
        "trajetto-api-migrate sem CRITICAL corrigível",
      );
      expect(result.summary).toContain("trajetto-ai sem CRITICAL corrigível");
    });

    it("fails on a finding only when enforced, and reports it otherwise", () => {
      sequenced("docker", [3, 0]);

      const enforced = exec(SCAN.run, env(true));

      expect(enforced.status).toBe(1);
      expect(enforced.log).toMatch(
        /::error::Trivy: CRITICAL corrigível em trajetto-api/,
      );

      sequenced("docker", [3, 0]);

      const reported = exec(SCAN.run, env(false));

      expect(reported.status, reported.log).toBe(0);
      expect(reported.log).toMatch(
        /::warning::Trivy: CRITICAL corrigível em trajetto-api/,
      );
      expect(reported.summary).toContain(
        "trajetto-api tem CRITICAL corrigível",
      );
    });

    it("tries a Trivy error again and never takes it for a finding, even enforced", () => {
      // The API's scan errors three times, the release image's and the
      // AI's are clean.
      sequenced("docker", [1, 1, 1, 0, 0]);

      const result = exec(SCAN.run, env(true));

      expect(result.status, result.log).toBe(0);
      expect(box.calls("docker")).toHaveLength(5);
      expect(result.log).toMatch(
        /::warning::Trivy: não conseguiu varrer trajetto-api/,
      );
      expect(result.summary).toContain("erro ao varrer trajetto-api");
      expect(result.summary).toContain("trajetto-ai sem CRITICAL corrigível");
    });

    it("skips the scan, without failing, when there is no database", () => {
      sequenced("docker", [0]);

      const result = exec(SCAN.run, env(true, "missing"));

      expect(result.status, result.log).toBe(0);
      expect(box.calls("docker")).toEqual([]);
      expect(result.log).toMatch(/::warning::Trivy: o scan não rodou/);
    });
  });
});
