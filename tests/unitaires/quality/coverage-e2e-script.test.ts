import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * coverage-e2e.sh measures the E2E suite in batches that take over an hour.
 * merge-coverage.mjs catches an edit that moves statements, but a function
 * added at a new place can leave every statement map intact; the script must
 * then refuse to merge rather than publish a number from two different trees.
 *
 * Runs the real script in a scratch tree, with `npx` stubbed (no vitest, no
 * DB): the stub writes an empty report and, when asked, edits src mid-run.
 */
const API = resolve(__dirname, "..", "..", "..");

let dir: string;

const scratchTree = (editSrcDuringBatch: boolean) => {
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
  mkdirSync(join(dir, "tests", "E2E"), { recursive: true });
  writeFileSync(join(dir, "tests", "E2E", "a.test.ts"), "");

  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "npx"),
    [
      "#!/usr/bin/env bash",
      'mkdir -p "$COVERAGE_DIR"',
      'echo "{}" > "$COVERAGE_DIR/coverage-final.json"',
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
});
