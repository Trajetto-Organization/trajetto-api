import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { replicaFileGlobs } from "../../E2E/support/replica-files";

/**
 * coverage-e2e.sh measures the E2E suite in batches that take over an hour.
 * merge-coverage.mjs catches an edit that moves statements, but a function
 * added at a new place can leave every statement map intact; the script must
 * then refuse to merge rather than publish a number from two different trees.
 *
 * Runs the real script in a scratch tree, with `npx` stubbed (no vitest, no
 * DB): the stub writes an empty report and, when asked, edits src mid-run.
 *
 * The files that start API replicas (tests/E2E/support/replica-files.ts) run
 * after the batches, one per batch, as `yarn test:e2e` runs them: the stub
 * records each call's files, and the scratch tree has one such file.
 */
const API = resolve(__dirname, "..", "..", "..");

let dir: string;

const scratchTree = (
  editSrcDuringBatch: boolean,
  oneAtATime: readonly string[] = ["socket-revocation.test.ts"],
) => {
  dir = mkdtempSync(join(tmpdir(), "cov-e2e-"));
  mkdirSync(join(dir, "infra", "scripts"), { recursive: true });
  for (const script of ["coverage-e2e.sh", "merge-coverage.mjs"]) {
    copyFileSync(
      join(API, "infra", "scripts", script),
      join(dir, "infra", "scripts", script),
    );
  }
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
  mkdirSync(join(dir, "tests", "E2E", "support"), { recursive: true });
  writeFileSync(join(dir, "tests", "E2E", "a.test.ts"), "");
  writeFileSync(join(dir, "tests", "E2E", "b.test.ts"), "");
  for (const name of oneAtATime) {
    writeFileSync(join(dir, "tests", "E2E", name), "");
  }
  copyFileSync(
    join(API, "tests", "E2E", "support", "replica-files.ts"),
    join(dir, "tests", "E2E", "support", "replica-files.ts"),
  );

  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "npx"),
    [
      "#!/usr/bin/env bash",
      'mkdir -p "$COVERAGE_DIR"',
      'echo "{}" > "$COVERAGE_DIR/coverage-final.json"',
      // The test files of each call, one line per batch.
      'files=(); for a in "$@"; do case "$a" in tests/E2E/*) files+=("$a");; esac; done',
      'echo "${files[*]}" >> calls.log',
      editSrcDuringBatch ? 'echo "export const b = () => 2;" >> src/a.ts' : "",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  return spawnSync(
    "bash",
    [join(dir, "infra", "scripts", "coverage-e2e.sh"), "8"],
    {
      encoding: "utf8",
      // The copied merge script resolves istanbul from the API's node_modules.
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        NODE_PATH: join(API, "node_modules"),
      },
    },
  );
};

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("coverage-e2e.sh", () => {
  it("refuses to merge when src changed while the batches ran", () => {
    const result = scratchTree(true);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("src changed while the batches ran");
    expect(existsSync(join(dir, "coverage", "all"))).toBe(false);
  });

  it("merges when the tree stayed frozen", () => {
    const result = scratchTree(false);

    expect(result.stderr).not.toContain("src changed");
    expect(result.status, result.stderr).toBe(0);
    expect(
      existsSync(join(dir, "coverage", "all", "coverage-summary.json")),
    ).toBe(true);
  });

  it("runs a file that starts replicas after the batches, in a batch of its own", () => {
    const result = scratchTree(false);

    expect(result.status, result.stderr).toBe(0);
    expect(
      readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n"),
    ).toEqual([
      "tests/E2E/a.test.ts tests/E2E/b.test.ts",
      "tests/E2E/socket-revocation.test.ts",
    ]);
  });

  /**
   * Every file `yarn test:e2e` runs one at a time, not only the ones that
   * start replicas: the cluster-sensitive list (SERIAL_E2E_FILES, F2-13) is
   * declared on one line, which the script's old pattern never read, so
   * driver-last-position-hot.test.ts ran beside seven other files and its
   * HOT ratio fell under the threshold. Driven by replicaFileGlobs(), the
   * phase vite.config.mts builds, so a list added there is checked here too.
   */
  it("runs every file of the one-at-a-time phase alone, after the batches", () => {
    const oneAtATime = replicaFileGlobs().map((glob) =>
      glob.replace(/^\*\*\//, ""),
    );

    expect(oneAtATime).toContain("driver-last-position-hot.test.ts");

    const result = scratchTree(false, oneAtATime);

    expect(result.status, result.stderr).toBe(0);

    const [shared, ...alone] = readFileSync(join(dir, "calls.log"), "utf8")
      .trim()
      .split("\n");

    expect(shared).toBe("tests/E2E/a.test.ts tests/E2E/b.test.ts");
    expect([...alone].sort()).toEqual(
      oneAtATime.map((name) => `tests/E2E/${name}`).sort(),
    );
  });
});
