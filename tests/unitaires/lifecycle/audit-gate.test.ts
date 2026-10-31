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
import { readWorkflow } from "./support/workflow-text";

/**
 * The dependency audit's gate (.github/scripts/audit-gate.sh, INFRA-16).
 *
 * audit-ci reads an advisory database that changes every day with no commit
 * of ours: a CRITICAL published this morning failed the next push of ANY
 * commit, a docs fix included, and the same commit that passed yesterday
 * failed today. Now the verdict blocks only a push or PR that changes what
 * the audit reads (a package.json, yarn.lock or package-lock.json anywhere,
 * or audit-ci.jsonc) — or one with no base to compare. Otherwise the audit
 * still runs, and a failure is a warning plus the report in the job summary;
 * Dependabot is the watch that opens the fix.
 *
 * Run for real against a git history built here, with audit-ci stubbed.
 */
const SCRIPT = repoFile(".github", "scripts", "audit-gate.sh");

describe.skipIf(!hasShell("bash"))(
  "the dependency audit's gate",
  { timeout: 30_000 },
  () => {
    let box: Sandbox;
    let repo: string;

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

    function commit(files: Record<string, string>) {
      for (const [path, content] of Object.entries(files)) {
        box.file(`repo/${path}`, content);
      }
      git("add", "-A");
      git("commit", "-q", "-m", "change");

      return git("rev-parse", "HEAD");
    }

    let base: string;

    beforeEach(() => {
      box = sandbox();
      repo = `${box.root}/repo`;
      box.file("repo/.keep", "");
      git("init", "-q");
      base = commit({
        "package.json": "{}",
        "yarn.lock": "# lock",
        "audit-ci.jsonc": "{}",
        "src/a.ts": "a",
      });
    });

    afterEach(() => box.dispose());

    /** audit-ci, answering `code` with a report (its verdict when not 0). */
    function audit(code: number) {
      box.stub(
        "fake-audit",
        [
          'echo "Found vulnerable advisory paths: GHSA-xxxx-yyyy-zzzz (CRITICAL)"',
          code === 0
            ? 'echo "Passed yarn security audit."'
            : 'echo "Failed security audit due to critical vulnerabilities."',
          `exit ${code}`,
        ].join("\n"),
      );
    }

    /**
     * audit-ci failing to audit at all (the registry not answering) on its
     * first `failures` calls, then passing; -1 never passes.
     */
    function unreachable(failures: number) {
      const counter = `${box.root}/audit.count`;

      writeFileSync(counter, "0");
      box.stub(
        "fake-audit",
        [
          `n=$(cat "${counter}"); echo $((n + 1)) > "${counter}"`,
          `if [ ${failures} -lt 0 ] || [ "$n" -lt ${failures} ]; then`,
          '  echo "Error: socket hang up (ECONNRESET)"',
          '  echo "Exiting..."',
          "  exit 1",
          "fi",
          'echo "Passed yarn security audit."',
        ].join("\n"),
      );
    }

    function gate(head: string, auditBase: string) {
      const summary = `${box.root}/summary`;

      writeFileSync(summary, "");

      const result = run("bash", SCRIPT, [], {
        bin: box.bin,
        cwd: repo,
        env: {
          AUDIT_BASE: auditBase,
          GITHUB_SHA: head,
          GITHUB_STEP_SUMMARY: summary,
          AUDIT_CMD: "fake-audit",
          AUDIT_RETRY_SECONDS: "0",
        },
      });

      return {
        ...result,
        log: result.stdout + result.stderr,
        summary: readFileSync(summary, "utf8"),
        audited: box.calls("fake-audit").length,
      };
    }

    it("reports, without blocking, a failure on a push that leaves the dependencies alone", () => {
      audit(1);
      const head = commit({ "src/a.ts": "b", "docs/x.md": "x" });

      const result = gate(head, base);

      expect(result.status, result.log).toBe(0);
      expect(result.audited).toBe(1);
      expect(result.log).toMatch(/só relata neste run/);
      expect(result.log).toMatch(
        /::warning::A auditoria de dependências reprovou/,
      );
      expect(result.summary).toMatch(/reprovou, sem bloquear/);
      // The report itself, for whoever reads the run.
      expect(result.summary).toContain("GHSA-xxxx-yyyy-zzzz");
    });

    it.each([
      ["yarn.lock", { "yarn.lock": "# lock 2" }],
      ["the root package.json", { "package.json": '{"x":1}' }],
      ["a nested package.json", { "tests/load/package.json": "{}" }],
      ["a package-lock.json", { "infra/tool/package-lock.json": "{}" }],
      [
        "audit-ci.jsonc (an exception taken out)",
        { "audit-ci.jsonc": '{"allowlist":[]}' },
      ],
    ])("blocks a push that changes %s", (_, files) => {
      audit(1);
      const head = commit(files as Record<string, string>);

      const result = gate(head, base);

      expect(result.status).toBe(1);
      expect(result.log).toMatch(/bloqueia este run \(muda /);
      expect(result.log).toMatch(
        /::error::A auditoria de dependências reprovou/,
      );
      expect(result.summary).toMatch(/reprovou e bloqueou/);
    });

    it.each([
      ["no base (a Run workflow)", ""],
      ["a new branch (before all zeros)", "0".repeat(40)],
      [
        "a base this checkout does not have (a force push)",
        "1234567890abcdef1234567890abcdef12345678",
      ],
    ])("blocks when there is %s to compare with", (_, auditBase) => {
      audit(1);
      const head = commit({ "src/a.ts": "c" });

      const result = gate(head, auditBase);

      expect(result.status).toBe(1);
      expect(result.log).toMatch(/bloqueia este run/);
    });

    it("passes a clean audit either way, and says so in the summary", () => {
      audit(0);
      const head = commit({ "yarn.lock": "# lock 3" });

      const result = gate(head, base);

      expect(result.status, result.log).toBe(0);
      expect(result.summary).toMatch(/nenhum CRITICAL de produção/);
    });

    it("keeps audit-ci's own exit code when it blocks", () => {
      audit(2);
      const head = commit({ "yarn.lock": "# lock 4" });

      expect(gate(head, base).status).toBe(2);
    });

    it("tries a failure to audit again, and passes once the registry answers", () => {
      unreachable(2);
      const head = commit({ "yarn.lock": "# lock 5" });

      const result = gate(head, base);

      expect(result.status, result.log).toBe(0);
      expect(result.audited).toBe(3);
      expect(
        result.log.match(/::warning::O audit-ci não conseguiu auditar/g),
      ).toHaveLength(2);
      expect(result.summary).toMatch(/nenhum CRITICAL de produção/);
    });

    it("never reads a registry that does not answer as an advisory, blocking only a dependency change", () => {
      unreachable(-1);
      const changed = commit({ "yarn.lock": "# lock 6" });

      const blocked = gate(changed, base);

      expect(blocked.status).toBe(1);
      expect(blocked.audited).toBe(3);
      expect(blocked.log).toMatch(/::error::O audit-ci não conseguiu auditar/);
      expect(blocked.log).not.toMatch(/reprovou/);
      expect(blocked.summary).toMatch(/não rodou.*bloqueia/);

      const code = commit({ "src/a.ts": "d" });
      const reported = gate(code, changed);

      expect(reported.status, reported.log).toBe(0);
      expect(reported.log).toMatch(
        /::warning::O audit-ci não conseguiu auditar/,
      );
      expect(reported.log).not.toMatch(/reprovou/);
      expect(reported.summary).toMatch(/não rodou.*não bloqueia/);
    });

    it("does not try a verdict again: an advisory is an answer", () => {
      audit(1);
      const head = commit({ "src/a.ts": "e" });

      expect(gate(head, base).audited).toBe(1);
    });

    it("runs the pinned audit-ci with the repository's config by default", () => {
      expect(readFileSync(SCRIPT, "utf8")).toMatch(
        /CMD=\$\{AUDIT_CMD:-\.\/node_modules\/\.bin\/audit-ci --config audit-ci\.jsonc\}/,
      );
    });
  },
);

describe("the workflows run the gate", () => {
  it.each([
    ["ci.yml", "validate", "AUDIT_BASE: ${{ github.event.before }}"],
    [
      "deploy.yml",
      "test",
      "AUDIT_BASE: ${{ github.event.pull_request.base.sha || github.event.before }}",
    ],
  ])("%s → %s compares with the base of the push or PR", (file, name, env) => {
    const workflow = readWorkflow(file);
    const job = workflow.jobs.find((each) => each.name === name)!;
    const step = job.steps.find(
      (each) => each.name === "Audit production dependencies",
    )!;

    expect(step.run.trim()).toBe("bash .github/scripts/audit-gate.sh");
    expect(step.text).toContain(env);
    // The comparison needs the history.
    expect(job.text).toContain("fetch-depth: 0");
  });
});
