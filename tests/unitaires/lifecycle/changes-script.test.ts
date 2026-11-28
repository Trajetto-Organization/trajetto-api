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
 * .github/scripts/changes.sh: what a push changes, for the `Changes` job of
 * ci.yml and staging.yml.
 *
 * - `docs`: a push that changes only documentation runs the secret scan and
 *   `Docs`, and builds nothing. On staging the push's own range decides (a
 *   documentation push there cancels nothing); on a work branch, the whole
 *   branch since it left staging (a newer push there cancels the older run,
 *   so documentation on top of code must still validate the code). With no
 *   range (Run workflow, a commit the checkout lacks) it is code, and
 *   everything runs.
 * - `audit_base`: on staging, the last build staging SERVED, not the
 *   previous push. A push that changed package.json and whose run was
 *   cancelled by a newer one used to leave that change out of every
 *   blocking audit: the newer run compared with it. On a work branch, the
 *   point where it left staging.
 *
 * Run for real against a git history built here, with GHCR as a tag table
 * and the runner's GITHUB_OUTPUT and GITHUB_STEP_SUMMARY as files.
 */
const SCRIPT = repoFile(".github", "scripts", "changes.sh");
const ZEROS = "0".repeat(40);
const digest = (char: string) => `sha256:${char.repeat(64)}`;
/** What a commit without infra/pgbouncer says about the PgBouncer image. */
const NO_PGBOUNCER = "pgbouncer=false\npgbouncer_tree=\n";
/** What a commit without either directory says about both images. */
const NO_IMAGES = `postgres=false\npostgres_tree=\n${NO_PGBOUNCER}`;

describe.skipIf(!hasShell("bash"))("changes.sh", { timeout: 30_000 }, () => {
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

    // A: code, staged. B: package.json (its run was cancelled: no marker).
    // C: code. D: documentation only.
    commit("A", { "src/a.ts": "a", "package.json": "{}" });
    commit("B", { "package.json": '{ "x": 1 }' });
    commit("C", { "src/c.ts": "c" });
    commit("D", { "docs/deploy.md": "d", "src/modules/x/NOTES.md": "n" });

    box.stub("sleep", "exit 0");
    ghcr({});
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

  /** The API of commit `name` staged on its own build. */
  const staged = (name: string, char = "1") => ({
    [`trajetto-api:sha-${commits[name].slice(0, 7)}`]: digest(char),
    [`trajetto-api:staged-${commits[name].slice(0, 7)}`]: digest(char),
  });

  function changes(
    mode: string,
    head: string,
    before: string,
    env: Record<string, string> = {},
  ) {
    const output = `${box.root}/output`;
    const summary = `${box.root}/summary`;

    writeFileSync(output, "");
    writeFileSync(summary, "");
    git("checkout", "-q", commits[head] ?? head);

    const result = run("bash", SCRIPT, [mode], {
      bin: box.bin,
      cwd: repo,
      env: {
        GITHUB_SHA: commits[head] ?? head,
        BEFORE: commits[before] ?? before,
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
        GHCR_ATTEMPTS: "2",
        GHCR_RETRY_SECONDS: "0",
        ...env,
      },
    });

    return {
      ...result,
      log: result.stdout + result.stderr,
      output: readFileSync(output, "utf8"),
      summary: readFileSync(summary, "utf8"),
    };
  }

  describe("on staging", () => {
    it("says a push of documentation only is documentation", () => {
      ghcr(staged("A"));

      const result = changes("staging", "D", "C");

      expect(result.status, result.log).toBe(0);
      expect(result.output).toBe(
        `docs=true\naudit_base=${commits.A}\n${NO_IMAGES}`,
      );
      expect(result.summary).toMatch(/só documentação desde/);
    });

    it("says a push with any code is code", () => {
      ghcr(staged("A"));

      const result = changes("staging", "C", "B");

      expect(result.status, result.log).toBe(0);
      expect(result.output).toMatch(/^docs=false\n/);
      expect(result.summary).toMatch(/muda código desde .*src\/c\.ts/);
    });

    it.each([
      ["Run workflow (no before)", ""],
      ["a new branch (before all zeros)", ZEROS],
      ["a commit the checkout does not have", "f".repeat(40)],
    ])("runs everything after %s", (_, before) => {
      ghcr(staged("A"));

      const result = changes("staging", "D", before);

      expect(result.status, result.log).toBe(0);
      expect(result.output).toMatch(/^docs=false\n/);
      expect(result.summary).toMatch(/sem intervalo para comparar/);
    });

    it("audits against the last build staging served, not the previous push", () => {
      // B (package.json) never got its marker: its run was cancelled by C.
      ghcr(staged("A"));

      const result = changes("staging", "C", "B");

      expect(result.output).toBe(
        `docs=false\naudit_base=${commits.A}\n${NO_IMAGES}`,
      );
      expect(result.summary).toContain(`staged-${commits.A.slice(0, 7)}`);
    });

    it("counts a marker only on the digest that commit built", () => {
      ghcr({
        ...staged("A"),
        [`trajetto-api:sha-${commits.C.slice(0, 7)}`]: digest("3"),
        [`trajetto-api:staged-${commits.C.slice(0, 7)}`]: digest("9"),
      });

      expect(changes("staging", "D", "C").output).toBe(
        `docs=true\naudit_base=${commits.A}\n${NO_IMAGES}`,
      );
    });

    it("takes the commit itself when staging served it (a run again)", () => {
      ghcr({ ...staged("A"), ...staged("C", "3") });

      expect(changes("staging", "C", "B").output).toBe(
        `docs=false\naudit_base=${commits.C}\n${NO_IMAGES}`,
      );
    });

    it("leaves the base empty, so the audit blocks, when no commit within reach was served", () => {
      const result = changes("staging", "D", "C", { STAGED_DEPTH: "3" });

      expect(result.status, result.log).toBe(0);
      expect(result.output).toBe(`docs=true\naudit_base=\n${NO_IMAGES}`);
      expect(result.summary).toMatch(/o audit bloqueia/);
    });

    it("falls back to the previous push, with a warning, when GHCR does not answer", () => {
      ghcr({ [`trajetto-api:staged-${commits.D.slice(0, 7)}`]: "error" });

      const result = changes("staging", "D", "C");

      expect(result.status, result.log).toBe(0);
      expect(result.output).toBe(
        `docs=true\naudit_base=${commits.C}\n${NO_IMAGES}`,
      );
      expect(result.log).toMatch(/::warning::O GHCR não respondeu/);
    });

    it("falls back the same way, without asking GHCR, when the job could not log in to it", () => {
      ghcr(staged("A"));

      const result = changes("staging", "D", "C", { GHCR_LOGIN: "failed" });

      expect(result.status, result.log).toBe(0);
      expect(result.output).toBe(
        `docs=true\naudit_base=${commits.C}\n${NO_IMAGES}`,
      );
      expect(result.log).toMatch(/::warning::O GHCR não respondeu/);
      expect(box.calls("docker")).toEqual([]);
    });
  });

  describe("on a work branch", () => {
    beforeEach(() => {
      // Staging is at B; the branch adds C and D on top of it.
      git("update-ref", "refs/remotes/origin/staging", commits.B);
    });

    // ci.yml cancels the older run of the branch. Classified by the push's
    // own range, D (documentation) on top of C (code) ran only `Docs`, and
    // C, cancelled, was never validated on the branch.
    it("compares what the whole branch changes, not the push's own range, and audits the same", () => {
      const result = changes("branch", "D", "C");

      expect(result.status, result.log).toBe(0);
      expect(result.output).toBe(
        `docs=false\naudit_base=${commits.B}\n${NO_IMAGES}`,
      );
      expect(result.summary).toMatch(/muda código desde .*src\/c\.ts/);
      // No GHCR on a work branch.
      expect(box.calls("docker")).toEqual([]);
    });

    it("says a branch of documentation only is documentation, whatever the push", () => {
      git("update-ref", "refs/remotes/origin/staging", commits.C);

      for (const before of ["C", ZEROS, "f".repeat(40)]) {
        expect(changes("branch", "D", before).output, before).toBe(
          `docs=true\naudit_base=${commits.C}\n${NO_IMAGES}`,
        );
      }
    });

    it("runs everything on Run workflow (no before), as asked", () => {
      git("update-ref", "refs/remotes/origin/staging", commits.C);

      const result = changes("branch", "D", "");

      expect(result.output).toBe(
        `docs=false\naudit_base=${commits.C}\n${NO_IMAGES}`,
      );
      expect(result.summary).toMatch(/sem intervalo para comparar/);
    });

    it("compares a new branch with where it left staging", () => {
      expect(changes("branch", "D", ZEROS).output).toBe(
        `docs=false\naudit_base=${commits.B}\n${NO_IMAGES}`,
      );

      git("update-ref", "refs/remotes/origin/staging", commits.C);

      expect(changes("branch", "D", ZEROS).output).toBe(
        `docs=true\naudit_base=${commits.C}\n${NO_IMAGES}`,
      );
    });

    it("runs everything, and the audit blocks, without origin/staging", () => {
      git("update-ref", "-d", "refs/remotes/origin/staging");

      const result = changes("branch", "D", ZEROS);

      expect(result.status, result.log).toBe(0);
      expect(result.output).toBe(`docs=false\naudit_base=\n${NO_IMAGES}`);
    });
  });

  // The trajetto-postgres image (plano-escala F1-03) is built from
  // infra/postgres alone: the Postgres image job runs only for a tree that
  // has no published image yet, and costs no runner otherwise.
  describe("the Postgres image", () => {
    let tree: string;

    beforeEach(() => {
      // E: the image's files arrive. F: code elsewhere, the same image.
      commit("E", { "infra/postgres/Dockerfile": "FROM postgres" });
      tree = git("rev-parse", "HEAD:infra/postgres");
      commit("F", { "src/f.ts": "f" });
    });

    const pg = (value: boolean) =>
      `postgres=${value}\npostgres_tree=${tree}\n${NO_PGBOUNCER}`;

    it("on staging, tests a tree GHCR has no image for, and says so", () => {
      ghcr(staged("A"));

      const result = changes("staging", "F", "E");

      expect(result.status, result.log).toBe(0);
      expect(tree).toMatch(/^[0-9a-f]{40}$/);
      expect(result.output).toBe(
        `docs=false\naudit_base=${commits.A}\n${pg(true)}`,
      );
      expect(result.summary).toContain(
        `infra/postgres sem imagem (src-${tree.slice(0, 12)})`,
      );
    });

    it("on staging, skips a tree whose image was already published", () => {
      ghcr({
        ...staged("A"),
        [`trajetto-postgres:src-${tree}`]: digest("7"),
      });

      const result = changes("staging", "F", "E");

      expect(result.output).toBe(
        `docs=false\naudit_base=${commits.A}\n${pg(false)}`,
      );
      expect(result.summary).toContain("o job Postgres image não roda");
    });

    it("on staging, runs the job when GHCR does not answer about it, with a warning", () => {
      ghcr({ ...staged("A"), [`trajetto-postgres:src-${tree}`]: "error" });

      const result = changes("staging", "F", "E");

      expect(result.status, result.log).toBe(0);
      expect(result.output).toContain(pg(true));
      expect(result.log).toMatch(
        /::warning::O GHCR não respondeu sobre trajetto-postgres/,
      );
    });

    it("on staging, runs the job without asking GHCR when the login failed", () => {
      ghcr({ ...staged("A"), [`trajetto-postgres:src-${tree}`]: digest("7") });

      const result = changes("staging", "F", "E", { GHCR_LOGIN: "failed" });

      expect(result.output).toContain(pg(true));
      expect(box.calls("docker")).toEqual([]);
    });

    it("on a work branch, runs the job only when the branch changes infra/postgres", () => {
      // Staging at D: the branch brings infra/postgres (E) and code (F).
      git("update-ref", "refs/remotes/origin/staging", commits.D);

      expect(changes("branch", "F", "E").output).toBe(
        `docs=false\naudit_base=${commits.D}\n${pg(true)}`,
      );

      // Staging already has E: the branch only adds F.
      git("update-ref", "refs/remotes/origin/staging", commits.E);

      const same = changes("branch", "F", "E");

      expect(same.output).toBe(
        `docs=false\naudit_base=${commits.E}\n${pg(false)}`,
      );
      expect(same.summary).toContain("a branch não muda infra/postgres");
      expect(box.calls("docker")).toEqual([]);

      // Run workflow: everything, as asked.
      expect(changes("branch", "F", "").output).toContain(pg(true));
    });
  });

  // The trajetto-pgbouncer image (plano-escala F4-35), built from
  // infra/pgbouncer alone, by the same rule as the Database's and on its
  // own: a new PgBouncer tree runs only the PgBouncer image job, and a
  // published Postgres tree says nothing about it.
  describe("the PgBouncer image", () => {
    let tree: string;
    let postgres: string;

    beforeEach(() => {
      // P: both images' files arrive. Q: code elsewhere, the same images.
      commit("P", {
        "infra/postgres/Dockerfile": "FROM postgres",
        "infra/pgbouncer/Dockerfile": "FROM alpine",
      });
      tree = git("rev-parse", "HEAD:infra/pgbouncer");
      postgres = git("rev-parse", "HEAD:infra/postgres");
      commit("Q", { "src/q.ts": "q" });
    });

    const both = (pg: boolean, bouncer: boolean) =>
      `postgres=${pg}\npostgres_tree=${postgres}\n` +
      `pgbouncer=${bouncer}\npgbouncer_tree=${tree}\n`;

    it("on staging, tests a tree GHCR has no image for, apart from the Postgres image", () => {
      ghcr({
        ...staged("A"),
        [`trajetto-postgres:src-${postgres}`]: digest("7"),
      });

      const result = changes("staging", "Q", "P");

      expect(result.status, result.log).toBe(0);
      expect(tree).toMatch(/^[0-9a-f]{40}$/);
      expect(tree).not.toBe(postgres);
      expect(result.output).toBe(
        `docs=false\naudit_base=${commits.A}\n${both(false, true)}`,
      );
      expect(result.summary).toContain(
        `Imagem do PgBouncer: infra/pgbouncer sem imagem (src-${tree.slice(0, 12)}): o job PgBouncer image testa`,
      );
    });

    it("on staging, skips a tree whose image was already published", () => {
      ghcr({
        ...staged("A"),
        [`trajetto-pgbouncer:src-${tree}`]: digest("8"),
      });

      const result = changes("staging", "Q", "P");

      expect(result.output).toBe(
        `docs=false\naudit_base=${commits.A}\n${both(true, false)}`,
      );
      expect(result.summary).toContain("o job PgBouncer image não roda");
    });

    it("on staging, runs the job when GHCR does not answer about it, or without a login", () => {
      ghcr({ ...staged("A"), [`trajetto-pgbouncer:src-${tree}`]: "error" });

      const down = changes("staging", "Q", "P");

      expect(down.status, down.log).toBe(0);
      expect(down.output).toContain(`pgbouncer=true\npgbouncer_tree=${tree}\n`);
      expect(down.log).toMatch(
        /::warning::O GHCR não respondeu sobre trajetto-pgbouncer/,
      );

      const noLogin = changes("staging", "Q", "P", { GHCR_LOGIN: "failed" });

      expect(noLogin.output).toContain(
        `pgbouncer=true\npgbouncer_tree=${tree}\n`,
      );
    });

    it("on a work branch, runs the job only when the branch changes infra/pgbouncer", () => {
      git("update-ref", "refs/remotes/origin/staging", commits.D);

      expect(changes("branch", "Q", "P").output).toBe(
        `docs=false\naudit_base=${commits.D}\n${both(true, true)}`,
      );

      git("update-ref", "refs/remotes/origin/staging", commits.P);

      const same = changes("branch", "Q", "P");

      expect(same.output).toBe(
        `docs=false\naudit_base=${commits.P}\n${both(false, false)}`,
      );
      expect(same.summary).toContain("a branch não muda infra/pgbouncer");
      expect(box.calls("docker")).toEqual([]);
    });
  });

  it("refuses a mode it does not know", () => {
    const result = changes("main", "D", "C");

    expect(result.status).toBe(1);
    expect(result.output).toBe("");
  });

  it("is what both Changes jobs run, on the push's before", () => {
    for (const [file, mode] of [
      ["ci.yml", "branch"],
      ["staging.yml", "staging"],
    ]) {
      const text = readFileSync(repoFile(".github", "workflows", file), "utf8");

      expect(text, file).toContain(
        `run: bash .github/scripts/changes.sh ${mode}`,
      );
      expect(text, file).toContain("BEFORE: ${{ github.event.before }}");
    }
  });
});
