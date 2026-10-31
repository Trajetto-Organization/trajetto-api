import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  hasShell,
  repoFile,
  run,
  sandbox,
  type Sandbox,
} from "./support/shell-harness";

/**
 * .github/scripts/staged-build.sh: which staging build a merge into main
 * promotes — asked by the PR check (`staging-image`) and by the promote.
 *
 * Staging builds and deploys the head of every push, and writes
 * `staged-<7>` on the digest it deployed. A commit pushed with [skip ci] has
 * no run at all, and a docs fix at the tip of staging used to block the
 * promote until the next code push. Now a commit that only changes
 * documentation (*.md, docs/**) since a commit staging deployed is promoted
 * with that commit's build: the images carry no documentation, so the bytes
 * are the same. Anything else still needs its own staging run.
 *
 * Run for real against a git history built here, with GHCR as a tag table.
 */
const SCRIPT = repoFile(".github", "scripts", "staged-build.sh");
const digest = (char: string) => `sha256:${char.repeat(64)}`;

describe.skipIf(!hasShell("bash"))(
  "staged-build.sh",
  { timeout: 30_000 },
  () => {
    let box: Sandbox;
    let repo: string;
    const commits: Record<string, string> = {};

    function git(...args: string[]) {
      const result = spawnSync(
        "git",
        [
          "-c",
          "user.name=Trajetto CI",
          "-c",
          "user.email=ci@trajetto.invalid",
          "-c",
          "commit.gpgsign=false",
          "-c",
          "core.hooksPath=/dev/null",
          ...args,
        ],
        { cwd: repo, encoding: "utf8" },
      );

      expect(result.status, result.stderr).toBe(0);

      return result.stdout.trim();
    }

    /** A commit that writes `files`, named `name`. */
    function commit(name: string, files: Record<string, string>) {
      for (const [path, content] of Object.entries(files)) {
        box.file(`repo/${path}`, content);
      }
      git("add", "-A");
      git("commit", "-q", "-m", name);
      commits[name] = git("rev-parse", "HEAD");
    }

    beforeEach(() => {
      box = sandbox();
      repo = `${box.root}/repo`;
      box.file("repo/.keep", "");
      git("init", "-q");

      // A: code. B: README. C: docs/. D: code. E: a changelog.
      commit("A", { "src/a.ts": "a", "README.md": "1" });
      commit("B", { "README.md": "2" });
      commit("C", { "docs/deploy.md": "c", "src/modules/x/NOTES.md": "n" });
      commit("D", { "src/b.ts": "b" });
      commit("E", { "CHANGELOG.md": "e" });

      box.stub("sleep", "exit 0");
    });

    afterEach(() => box.dispose());

    /** GHCR: `<image>:<tag> <answer>` lines; "error" is a 503 for that ref. */
    function ghcr(tags: Record<string, string>) {
      writeFileSync(
        `${box.root}/tags`,
        Object.entries(tags)
          .map(
            ([ref, value]) => `ghcr.io/trajetto-organization/${ref} ${value}\n`,
          )
          .join(""),
      );
      box.stub(
        "docker",
        [
          `found=$(awk -v ref="$4" '$1 == ref { print $2 }' "${box.root}/tags")`,
          '[ "$found" != "error" ] || { echo "ERROR: 503 Service Unavailable" >&2; exit 1; }',
          '[ -n "$found" ] || { echo "ERROR: $4: not found" >&2; exit 1; }',
          'printf "%s\\n" "$found"',
        ].join("\n"),
      );
    }

    /** Both images staged on their own digests for commit `name`. */
    const staged = (name: string, api = "1", ai = "a") => {
      const short = commits[name].slice(0, 7);

      return {
        [`trajetto-api:sha-${short}`]: digest(api),
        [`trajetto-api:staged-${short}`]: digest(api),
        [`trajetto-ai:sha-${short}`]: digest(ai),
        [`trajetto-ai:staged-${short}`]: digest(ai),
      };
    };

    /** Runs the script for commit `name` (or a raw sha). */
    function build(name: string) {
      const sha = commits[name] ?? name;
      const output = `${box.root}/output`;
      const summary = `${box.root}/summary`;

      writeFileSync(output, "");
      writeFileSync(summary, "");

      const result = run("bash", SCRIPT, [sha], {
        bin: box.bin,
        cwd: repo,
        env: { GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary },
      });

      return {
        ...result,
        outputs: readFileSync(output, "utf8"),
        summary: readFileSync(summary, "utf8"),
      };
    }

    it("answers the commit itself when staging deployed it", () => {
      ghcr(staged("E"));

      const result = build("E");

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(`${commits.E}\n`);
      expect(result.outputs).toBe(
        `commit=${commits.E}\ntag=sha-${commits.E.slice(0, 7)}\n`,
      );
      expect(result.summary).toContain(`staged-${commits.E.slice(0, 7)}`);
    });

    it("answers the nearest staged ancestor when only documentation changed since", () => {
      // C (docs/, and a NOTES.md under src/) and B (README) since A.
      ghcr(staged("A"));

      const result = build("C");

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(`${commits.A}\n`);
      expect(result.outputs).toBe(
        `commit=${commits.A}\ntag=sha-${commits.A.slice(0, 7)}\n`,
      );
      expect(result.stderr).toMatch(/::notice::.* só muda documentação desde/);
      expect(result.summary).toContain(`sha-${commits.A.slice(0, 7)}`);
    });

    it("prefers the nearest one when several were staged", () => {
      ghcr({ ...staged("A", "1"), ...staged("B", "2") });

      const result = build("C");

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(`${commits.B}\n`);
    });

    it("refuses when code changed since the nearest staged commit, naming the files", () => {
      // E is a changelog, but D (code) sits between it and A.
      ghcr(staged("A"));

      const result = build("E");

      expect(result.status).toBe(3);
      expect(result.stdout).toBe("");
      expect(result.outputs).toBe("");
      expect(result.stderr).toContain("src/b.ts");
      expect(result.stderr).toMatch(/mudou mais que documentação/);
    });

    it("answers D's own build for E once D is staged: E is only a changelog", () => {
      ghcr({ ...staged("A", "1"), ...staged("D", "4") });

      const result = build("E");

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(`${commits.D}\n`);
    });

    it("reads a pt-BR file name as itself, not as an escaped, quoted path", () => {
      commit("F", { "docs/decisões.md": "f", "infra/notas/operação.md": "o" });
      ghcr(staged("E"));

      const result = build("F");

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(`${commits.E}\n`);
    });

    it("takes a file moved out of the code into docs/ for a code change", () => {
      git("mv", "src/b.ts", "docs/b.ts");
      git("commit", "-q", "-m", "G");
      commits.G = git("rev-parse", "HEAD");
      ghcr(staged("E"));

      const result = build("G");

      expect(result.status).toBe(3);
      expect(result.stderr).toContain("src/b.ts");
    });

    it("refuses a code commit staging never ran", () => {
      ghcr(staged("C"));

      const result = build("D");

      expect(result.status).toBe(3);
      expect(result.stderr).toContain("src/b.ts");
    });

    it("refuses a marker on another digest than the build", () => {
      ghcr({
        ...staged("E"),
        [`trajetto-ai:staged-${commits.E.slice(0, 7)}`]: digest("b"),
      });

      const result = build("E");

      expect(result.status).toBe(4);
      expect(result.stderr).toMatch(
        /::error::.*trajetto-ai:staged-\w{7} aponta para/,
      );
    });

    it("does not take a marker missing for one image as staged", () => {
      const tags = staged("E");

      delete tags[`trajetto-ai:staged-${commits.E.slice(0, 7)}`];
      ghcr(tags);

      expect(build("E").status).toBe(3);
    });

    it("lets a build older than the AI service through on the API's marker, with a warning", () => {
      const short = commits.E.slice(0, 7);

      ghcr({
        [`trajetto-api:sha-${short}`]: digest("1"),
        [`trajetto-api:staged-${short}`]: digest("1"),
      });

      const result = build("E");

      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain(
        `::warning::trajetto-ai:sha-${short} não existe`,
      );
    });

    it("never lets the API be the one left out", () => {
      const short = commits.E.slice(0, 7);

      ghcr({
        [`trajetto-ai:sha-${short}`]: digest("a"),
        [`trajetto-ai:staged-${short}`]: digest("a"),
      });

      expect(build("E").status).toBe(3);
    });

    it("fails, naming GHCR, when the registry does not answer — not 'not staged'", () => {
      ghcr({ [`trajetto-api:sha-${commits.E.slice(0, 7)}`]: "error" });

      const result = build("E");

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/::error::GHCR indisponível/);
    });

    it("refuses what is not a full commit sha", () => {
      ghcr({});

      for (const value of ["", "abcdef0", "sha-abcdef0", "HEAD"]) {
        const result = run("bash", SCRIPT, [value], {
          bin: box.bin,
          cwd: repo,
        });

        expect(result.status, value).toBe(1);
        expect(result.stderr).toMatch(
          /::error::staged-build\.sh precisa do sha completo/,
        );
      }
    });

    it("fails when git does not know the commit (a shallow or wrong checkout)", () => {
      ghcr({});

      const result = build("0123456789abcdef0123456789abcdef01234567");

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/::error::git não conhece o commit/);
    });
  },
);

/**
 * The rule promotes an earlier commit's build for a commit that changes only
 * documentation. That holds only while no image carries documentation: the
 * API's build context leaves out every `*.md` (at any depth — `*.md` alone
 * matched the root only, and the runner copies prisma/ whole) and docs/, and
 * the AI's Dockerfile copies named files only.
 */
describe("no image carries what the documentation rule calls documentation", () => {
  const lines = (path: string) =>
    readFileSync(repoFile(path), "utf8")
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((line) => line.trim());

  it("the API's .dockerignore leaves out *.md at any depth, and docs/", () => {
    const ignored = lines(".dockerignore");

    expect(ignored).toContain("**/*.md");
    expect(ignored).toContain("docs/");
  });

  it("the AI image copies named files, never the whole context", () => {
    const copies = lines("infra/ai-ocr/Dockerfile").filter((line) =>
      /^COPY\s/.test(line),
    );

    expect(copies.length).toBeGreaterThan(0);
    for (const copy of copies) {
      expect(copy).not.toMatch(/\s\.\s/);
      expect(copy).not.toMatch(/\.md(\s|$)/);
    }
  });
});
