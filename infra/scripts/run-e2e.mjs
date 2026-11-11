/**
 * `yarn test:e2e`: the E2E suite in two phases (vite.config.mts, E2E_PHASE).
 *
 *  1. `shared` — every file that does not start API replicas, in parallel;
 *  2. `replicas` — the files that do (tests/E2E/support/replica-files.ts),
 *     one at a time, so the processes they start never compete with the rest
 *     of the suite for the runner's CPUs.
 *
 * The second phase runs even when the first failed: one CI run reports every
 * failure. The exit code is the first non-zero one.
 *
 * Every argument goes to both phases (the CI passes `--run --reporter=basic`).
 * A filter (an argument that is not an option) may match files of one phase
 * only, so the phases then accept finding none (`--passWithNoTests`). Without
 * a filter they do not: a phase that finds no file is a broken split, and it
 * fails. For a single file, `npx vitest run tests/E2E/<file>.test.ts` is still
 * the way (no phase, every file included).
 *
 * E2E_SHARD=<i>/<n> runs one of the CI's n parallel jobs (validate.yml):
 * jobs 1 to n−1 split the shared phase with vitest's own `--shard`, and job
 * n runs the replica phase whole. Its files run one at a time and start
 * processes vitest does not count, so they get a job of their own instead of
 * a slice beside the others; the shared slices take the rest of the time.
 * n = 1, or no E2E_SHARD, is the whole suite, as above.
 *
 * tests/unitaires/quality/e2e-replica-isolation.test.ts checks `e2ePhases`,
 * and e2e-shards.test.ts the slices the CI's matrix makes.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** `<i>/<n>` → { index, count }; undefined when there is no shard. */
function parseShard(shard) {
  if (shard === undefined || shard === "") return undefined;

  const match = /^(\d+)\/(\d+)$/.exec(shard);
  const index = match ? Number(match[1]) : 0;
  const count = match ? Number(match[2]) : 0;

  if (!match || count < 1 || index < 1 || index > count) {
    throw new Error(
      `E2E_SHARD precisa ser <i>/<n>, com 1 ≤ i ≤ n (recebido: '${shard}').`,
    );
  }

  return { index, count };
}

/** What each phase runs: vitest's arguments and the phase it is. */
function e2ePhases(forwarded, shard = process.env.E2E_SHARD) {
  const filtered = forwarded.some((argument) => !argument.startsWith("-"));
  const base = [
    "run",
    "--dir",
    "./tests/E2E",
    ...(filtered ? ["--passWithNoTests"] : []),
    ...forwarded,
  ];
  const split = parseShard(shard);

  if (!split || split.count === 1) {
    return ["shared", "replicas"].map((phase) => ({ phase, args: base }));
  }

  if (split.index === split.count) return [{ phase: "replicas", args: base }];

  return [
    {
      phase: "shared",
      args: [...base, `--shard=${split.index}/${split.count - 1}`],
    },
  ];
}

function main() {
  const require = createRequire(import.meta.url);
  const vitest = join(
    dirname(require.resolve("vitest/package.json")),
    "vitest.mjs",
  );

  let status = 0;

  for (const { phase, args } of e2ePhases(process.argv.slice(2))) {
    console.log(`\n== E2E, fase ${phase} ==\n`);

    const result = spawnSync(process.execPath, [vitest, ...args], {
      stdio: "inherit",
      env: { ...process.env, E2E_PHASE: phase },
    });

    const code = result.status ?? 1;

    if (result.error) console.error(result.error);
    if (code !== 0) console.error(`\nE2E, fase ${phase}: código ${code}`);
    if (status === 0) status = code;
  }

  process.exit(status);
}

// Run, not imported (the test imports `e2ePhases`). Windows paths compare
// without case: the drive letter comes either way.
const self = fileURLToPath(import.meta.url);
const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
const same = (a, b) =>
  process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

if (same(self, invoked)) main();

export { e2ePhases, parseShard };
