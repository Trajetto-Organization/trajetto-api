import { readFileSync, writeFileSync } from "node:fs";

import { run, type Sandbox } from "./shell-harness";

/**
 * Runs a workflow's `run:` block as GitHub runs it with `shell: bash`
 * (bash -eo pipefail), with the runner's files simulated: GITHUB_OUTPUT and
 * GITHUB_STEP_SUMMARY start empty and are read back. The sandbox's stubs
 * come first on PATH.
 */
export interface BlockResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** stdout and stderr together. */
  log: string;
  /** GITHUB_OUTPUT as written, one `key=value` per line. */
  output: string;
  /** GITHUB_OUTPUT as an object (the last value of a key wins). */
  outputs: Record<string, string>;
  summary: string;
}

export function runBlock(
  box: Sandbox,
  script: string,
  env: Record<string, string> = {},
  cwd?: string,
): BlockResult {
  const output = `${box.root}/github-output`;
  const summary = `${box.root}/github-step-summary`;

  writeFileSync(output, "");
  writeFileSync(summary, "");

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
  const written = readFileSync(output, "utf8");

  return {
    ...result,
    log: result.stdout + result.stderr,
    output: written,
    outputs: Object.fromEntries(
      written
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split(/=(.*)/s).slice(0, 2) as [string, string]),
    ),
    summary: readFileSync(summary, "utf8"),
  };
}
