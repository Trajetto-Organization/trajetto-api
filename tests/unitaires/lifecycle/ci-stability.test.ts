import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hasShell, run, sandbox, type Sandbox } from "./support/shell-harness";
import {
  allWorkflows,
  readWorkflow,
  timeoutOf,
  type Job,
  type Step,
} from "./support/workflow-text";

/**
 * A red pipeline means the code is wrong — never the network, a registry, a
 * moving tag or a step that hung (CI audit of 30/10/2026: runs that failed,
 * or passed, for reasons outside the code). What every workflow holds to,
 * so none of those comes back:
 *
 * - every job has its own timeout (a hung step held the runner up to 6 h of
 *   a 2,000-minute month);
 * - every `run:` is `bash -eo pipefail` (GitHub's default for a step with no
 *   `shell:` has no pipefail: `git ls-remote | cut` failing handed an empty
 *   sha on, and the staging deploy was skipped, green);
 * - Node is the Dockerfile base's exact version, and every image a job pulls
 *   is pinned by digest, the same digest everywhere;
 * - the GitHub cache is an optimisation that never fails a build;
 * - GHCR is read only through ghcr.sh, which tells "not found" from "did
 *   not answer";
 * - the Prisma engines and Trivy's database are cached, and their download
 *   failing says so instead of failing (or passing) something else.
 *
 * The `run:` blocks that decide are executed here, with the external
 * commands stubbed.
 */
const ROOT = process.cwd();
const workflows = allWorkflows();
const deploy = readWorkflow("deploy.yml");
const ci = readWorkflow("ci.yml");

const job = (workflow: typeof deploy, name: string): Job => {
  const found = workflow.jobs.find((each) => each.name === name);

  expect(found, `${workflow.file} → ${name}`).toBeDefined();

  return found!;
};

const step = (owner: Job, name: string): Step => {
  const found = owner.steps.find((each) => each.name === name);

  expect(found, `${owner.name} → ${name}`).toBeDefined();

  return found!;
};

/** The Node version of the Dockerfile base: node:<x.y.z>-alpine… */
const dockerNode = /^FROM node:(\d+\.\d+\.\d+)-alpine/m.exec(
  readFileSync(resolve(ROOT, "Dockerfile"), "utf8"),
)?.[1];

describe("every job of every workflow", () => {
  it("has workflows to check", () => {
    expect(workflows.map((each) => each.file)).toEqual(
      expect.arrayContaining(["ci.yml", "cloudflare-ranges.yml", "deploy.yml"]),
    );
  });

  it.each(workflows.map((each) => [each.file, each] as const))(
    "%s: every job has its own timeout, with headroom and below GitHub's 6 h",
    (_, workflow) => {
      expect(workflow.jobs.length).toBeGreaterThan(0);

      for (const each of workflow.jobs) {
        const minutes = timeoutOf(each);

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

  it("keeps the timeouts that cover the measured worst case", () => {
    // The E2E phases (shared, then the replica files one at a time) on the
    // 2-vCPU runner took up to 47 min; the staging deploy covers six
    // Dokploy attempts per service; the PR check waits up to 45 min.
    expect(timeoutOf(job(deploy, "test"))).toBeGreaterThanOrEqual(90);
    expect(timeoutOf(job(deploy, "deploy-staging"))).toBeGreaterThanOrEqual(
      120,
    );
    expect(timeoutOf(job(deploy, "promote-production"))).toBeGreaterThanOrEqual(
      120,
    );
    expect(timeoutOf(job(deploy, "staging-image"))).toBeGreaterThan(45);
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

    for (const workflow of workflows) {
      for (const each of workflow.jobs) {
        for (const item of each.steps) {
          if (!item.run) continue;

          // Expressions are filled in by GitHub before bash sees the script.
          const script = box.file(
            "syntax.sh",
            item.run.replace(/\$\{\{[^}]*\}\}/g, "x"),
          );
          const result = spawnSync("bash", ["-n", script], {
            encoding: "utf8",
          });

          if (result.status !== 0) {
            broken.push(
              `${workflow.file} → ${each.name} → ${item.name}: ${result.stderr}`,
            );
          }
        }
      }
    }

    expect(broken).toEqual([]);
  });
});

describe("pinned versions", () => {
  it("knows the Dockerfile base's Node version", () => {
    expect(dockerNode).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("sets up exactly that Node in every job that runs node, yarn or npx", () => {
    const values = workflows.flatMap((workflow) =>
      [...workflow.text.matchAll(/node-version:\s*(\S+)/g)].map(
        ([, value]) => `${workflow.file}: ${value}`,
      ),
    );

    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      expect(value).toMatch(new RegExp(`: "${dockerNode}"$`));
    }

    for (const workflow of workflows) {
      for (const each of workflow.jobs) {
        const usesNode = each.steps.some((item) =>
          /(^|\n|&&\s*)\s*(node|yarn|npx)\s/.test(item.run),
        );

        if (!usesNode) continue;

        expect(
          each.steps.some((item) =>
            item.text.includes("uses: actions/setup-node@"),
          ),
          `${workflow.file} → ${each.name}`,
        ).toBe(true);
      }
    }
  });

  it("pins every image a job pulls by digest, the same digest everywhere", () => {
    const refs = workflows.flatMap((workflow) =>
      [
        // services.*.image
        ...workflow.text.matchAll(/^\s+image:\s*(\S+)/gm),
        // POSTGRES_IMAGE, TRIVY_IMAGE…
        ...workflow.text.matchAll(/^\s+[A-Z_]+_IMAGE:\s*(\S+)/gm),
        // Buildx's BuildKit
        ...workflow.text.matchAll(/driver-opts:\s*image=(\S+)/g),
        // `docker run` straight from a registry (gitleaks)
        ...workflow.text.matchAll(/^\s+(zricethezav\/\S+|aquasec\/\S+)/gm),
      ]
        .map(([, ref]) => ({ file: workflow.file, ref }))
        // Our own images go by the digest the job just read (an expression).
        .filter(({ ref }) => !ref.includes("${{")),
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
      ]),
    );
  });

  it("pins BuildKit wherever Buildx is set up", () => {
    for (const workflow of workflows) {
      for (const each of workflow.jobs) {
        for (const item of each.steps) {
          if (!item.text.includes("uses: docker/setup-buildx-action@"))
            continue;

          expect(item.text, `${workflow.file} → ${each.name}`).toMatch(
            /driver-opts: image=moby\/buildkit:v[\d.]+@sha256:[0-9a-f]{64}/,
          );
        }
      }
    }
  });
});

describe("the runner", () => {
  // ubuntu-latest began moving to 26.04 on 19/10/2026, with no commit of
  // ours; Playwright 1.56 refused it in the web's suites. Every job runs on
  // the same pinned image, bumped by hand in the three repositories.
  it("is a pinned Ubuntu in every job, never ubuntu-latest", () => {
    for (const { file, text } of workflows) {
      const runners = [...text.matchAll(/\n\s+runs-on: (\S+)/g)].map(
        (match) => match[1],
      );

      expect(runners.length, file).toBeGreaterThan(0);
      for (const runner of runners) {
        expect(runner, file).toMatch(/^ubuntu-\d{2}\.\d{2}$/);
      }
    }
  });
});

describe("the type-check", () => {
  // tsc holds about 2.3 GB live here; Node's default heap on a 7-8 GB
  // runner (a private repository's) is about 2 GB, and the check died with
  // "JavaScript heap out of memory" in a 7 GB Linux container (30/10/2026).
  it("gets a fixed heap with room over what tsc uses, in every workflow that runs it", () => {
    for (const file of ["ci.yml", "deploy.yml"]) {
      const { text } = readWorkflow(file);
      const at = text.indexOf("- name: Type-check");

      expect(at, `${file}: passo Type-check`).toBeGreaterThan(-1);

      const step = text.slice(at, text.indexOf("- name:", at + 1));
      const heap = Number(
        /NODE_OPTIONS: --max-old-space-size=(\d+)/.exec(step)?.[1],
      );

      expect(heap, `${file}: heap do tsc`).toBeGreaterThanOrEqual(4096);
    }
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
    for (const workflow of [deploy, ci]) {
      const build = step(
        job(workflow, "ai-ocr"),
        "Build the image and run its tests",
      ).text;

      expect(build).toContain("uses: docker/build-push-action@");
      expect(build).toContain("target: test");
      expect(build).toContain("cache-from: type=gha,scope=ai-test");
      expect(build).toContain(
        "cache-to: type=gha,mode=max,scope=ai-test,ignore-error=true",
      );
    }

    const push = step(
      job(deploy, "build-and-push"),
      "Build and push the AI image",
    ).text;

    expect(push).toContain("type=gha,scope=ai-test");
  });

  it("cache the Prisma engines by their version, before the install", () => {
    for (const [workflow, name] of [
      [deploy, "test"],
      [ci, "validate"],
    ] as const) {
      const owner = job(workflow, name);
      const names = owner.steps.map((item) => item.name);
      const cache = step(owner, "Cache the Prisma engines").text;

      expect(names.indexOf("Prisma engines version")).toBeLessThan(
        names.indexOf("Cache the Prisma engines"),
      );
      expect(names.indexOf("Cache the Prisma engines")).toBeLessThan(
        names.indexOf("Install dependencies"),
      );
      expect(cache).toContain("path: ~/.cache/prisma");
      expect(cache).toContain(
        "key: prisma-engines-${{ runner.os }}-${{ steps.prisma-engines.outputs.version }}",
      );
    }

    // The E2E migrates: the engine is checked before it.
    const names = job(deploy, "test").steps.map((item) => item.name);

    expect(names.indexOf("Install dependencies")).toBeLessThan(
      names.indexOf("Make sure the Prisma schema engine is installed"),
    );
    expect(
      names.indexOf("Make sure the Prisma schema engine is installed"),
    ).toBeLessThan(names.indexOf("Run E2E tests"));
  });
});

describe("GHCR", () => {
  it("is read and written only through ghcr.sh: no swallowed errors", () => {
    for (const workflow of workflows) {
      for (const each of workflow.jobs) {
        for (const item of each.steps) {
          expect(item.run, `${each.name} → ${item.name}`).not.toMatch(
            /docker buildx imagetools/,
          );
          expect(item.run, `${each.name} → ${item.name}`).not.toMatch(
            /2>\s*\/dev\/null\s*\|\|\s*true/,
          );
        }
      }
    }

    expect(deploy.text).toContain("bash .github/scripts/ghcr.sh digest");
    expect(deploy.text).toContain("bash .github/scripts/ghcr.sh tag");
  });

  it("is reachable by every job that calls the script: it checks the scripts out", () => {
    for (const each of deploy.jobs) {
      const calls = each.steps.some((item) =>
        /bash \.github\/scripts\//.test(item.run),
      );

      if (!calls) continue;

      expect(
        each.steps.some((item) =>
          item.text.includes("uses: actions/checkout@"),
        ),
        each.name,
      ).toBe(true);
    }
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

  function exec(
    script: string,
    env: Record<string, string> = {},
    cwd?: string,
  ) {
    const output = `${box.root}/output`;
    const summary = `${box.root}/summary`;

    writeFileSync(output, "");
    writeFileSync(summary, "");

    // As GitHub runs a `run:` block with `shell: bash`.
    const file = box.file("block.sh", `set -eo pipefail\n${script}`);
    const result = run("bash", file, [], {
      bin: box.bin,
      cwd,
      env: {
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
        ...env,
      },
    });

    return {
      ...result,
      log: result.stdout + result.stderr,
      outputs: readFileSync(output, "utf8"),
      summary: readFileSync(summary, "utf8"),
    };
  }

  describe("the branch-head check of the staging deploy", () => {
    const HEAD = step(
      job(deploy, "deploy-staging"),
      "Is this run still the branch head?",
    ).run;
    const SHA = "abcdef0123456789abcdef0123456789abcdef01";

    it("deploys when the read sha is this run's", () => {
      box.stub("git", `printf '%s\\trefs/heads/staging\\n' "${SHA}"`);

      const result = exec(HEAD, {
        GITHUB_REF: "refs/heads/staging",
        GITHUB_SHA: SHA,
      });

      expect(result.status, result.log).toBe(0);
      expect(result.outputs).toBe("current=true\n");
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

      const result = exec(HEAD, {
        GITHUB_REF: "refs/heads/staging",
        GITHUB_SHA: SHA,
      });

      expect(result.status, result.log).toBe(0);
      expect(result.outputs).toBe("current=true\n");
      expect(result.log.match(/::warning::A leitura da cabeça/g)).toHaveLength(
        2,
      );
    });

    it("fails, instead of skipping the deploy green, when GitHub never answers", () => {
      box.stub("git", "exit 128");

      const result = exec(HEAD, {
        GITHUB_REF: "refs/heads/staging",
        GITHUB_SHA: SHA,
      });

      expect(result.status).toBe(1);
      expect(result.outputs).toBe("");
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

    const runHead = () =>
      exec(HEAD, { GITHUB_REF: "refs/heads/staging", GITHUB_SHA: SHA });

    it("leaves staging to a newer run that changes code, green", () => {
      newerHead(["docs/deploy.md", "src/server.ts"]);

      const result = runHead();

      expect(result.status, result.log).toBe(0);
      expect(result.outputs).toBe("current=false\n");
      expect(result.log).toMatch(
        /::notice::staging já está em f{40}: este run/,
      );
    });

    it("deploys anyway when the newer head only adds documentation (a [skip ci] commit runs no pipeline)", () => {
      newerHead(["docs/deploy.md", "README.md", "infra/traefik/README.md"]);

      const result = runHead();

      expect(result.status, result.log).toBe(0);
      expect(result.outputs).toBe("current=true\n");
      expect(result.log).toMatch(/só acrescenta documentação a este build/);
      expect(
        box.calls("git").some((call) => call.includes("diff --no-renames")),
      ).toBe(true);
    });

    it("leaves staging alone when the newer head does not descend from this commit", () => {
      newerHead(["docs/deploy.md"], { ancestor: 1 });

      const result = runHead();

      expect(result.status, result.log).toBe(0);
      expect(result.outputs).toBe("current=false\n");
      // Not a descendant: nothing to compare.
      expect(box.calls("git").some((call) => call.includes("diff"))).toBe(
        false,
      );
    });

    it("tries the fetch of the newer head again, then decides", () => {
      newerHead(["README.md"], { fetch: [128, 0] });

      const result = runHead();

      expect(result.status, result.log).toBe(0);
      expect(result.outputs).toBe("current=true\n");
      expect(
        result.log.match(/::warning::A busca de f{40} falhou/g),
      ).toHaveLength(1);
    });

    it("fails, instead of guessing, when the newer head cannot be fetched", () => {
      newerHead(["README.md"], { fetch: [128] });

      const result = runHead();

      expect(result.status).toBe(1);
      expect(result.outputs).toBe("");
      expect(result.log).toMatch(/::error::Não deu para buscar f{40}/);
      expect(
        box.calls("git").filter((call) => call.startsWith("git fetch")),
      ).toHaveLength(3);
    });

    it("fails when git cannot tell whether the head descends from this commit", () => {
      newerHead(["README.md"], { ancestor: 128 });

      const result = runHead();

      expect(result.status).toBe(1);
      expect(result.outputs).toBe("");
      expect(result.log).toMatch(/::error::git merge-base não comparou/);
    });
  });

  describe("the Prisma engines", () => {
    it("are keyed by the engines version yarn.lock resolves", () => {
      const result = exec(
        step(job(deploy, "test"), "Prisma engines version").run,
      );
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
      expect(result.outputs).toBe(`version=${version}\n`);
    });

    const CHECK = step(
      job(deploy, "test"),
      "Make sure the Prisma schema engine is installed",
    ).run;

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

  describe("Trivy's vulnerability database", () => {
    const DOWNLOAD = step(
      job(deploy, "build-and-push"),
      "Download the vulnerability database",
    ).run;

    it("is downloaded once, into the cached directory, as the runner's user", () => {
      sequenced("docker", [0]);

      const result = exec(DOWNLOAD, {
        HOME: box.root,
        TRIVY_IMAGE: "aquasec/trivy:0@sha256:x",
      });

      expect(result.status, result.log).toBe(0);
      expect(result.outputs).toBe("db=fresh\n");

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
      expect(result.outputs).toBe("db=cached\n");
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
      expect(result.outputs).toBe("db=missing\n");
      expect(result.summary).toContain("o scan não rodou");
    });
  });

  describe("the image scan", () => {
    const SCAN = step(
      job(deploy, "build-and-push"),
      "Scan the images for fixable critical vulnerabilities",
    );

    const env = (enforce: boolean, db = "fresh") => ({
      HOME: box.root,
      TRIVY_IMAGE: "aquasec/trivy:0@sha256:x",
      API_IMAGE: `ghcr.io/trajetto-organization/trajetto-api@sha256:${"1".repeat(64)}`,
      AI_IMAGE: `ghcr.io/trajetto-organization/trajetto-ai@sha256:${"a".repeat(64)}`,
      ENFORCE: enforce ? "true" : "false",
      DB: db,
    });

    it("has no continue-on-error left to hide a broken scan", () => {
      expect(SCAN.text).not.toContain("continue-on-error");
      expect(SCAN.text).toContain(
        "ENFORCE: ${{ vars.IMAGE_SCAN_ENFORCE == 'true' }}",
      );
      expect(SCAN.run).toContain("--skip-db-update");
      expect(SCAN.run).toContain("--exit-code 3");
    });

    it("passes clean images and writes each verdict in the summary", () => {
      sequenced("docker", [0]);

      const result = exec(SCAN.run, env(true));

      expect(result.status, result.log).toBe(0);
      expect(result.summary).toContain("trajetto-api sem CRITICAL corrigível");
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
      // The API's scan errors three times, the AI's is clean.
      sequenced("docker", [1, 1, 1, 0]);

      const result = exec(SCAN.run, env(true));

      expect(result.status, result.log).toBe(0);
      expect(box.calls("docker")).toHaveLength(4);
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
