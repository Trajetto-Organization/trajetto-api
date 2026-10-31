import {
  configDefaults,
  coverageConfigDefaults,
  defineConfig,
} from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

import {
  E2E_PHASE_REPLICAS,
  E2E_PHASE_SHARED,
  replicaFileGlobs,
} from "./tests/E2E/support/replica-files";

// Vitest's default coverage exclude also drops `*-spec.ts` / `*-test.ts`, a
// plausible name for product code (the web's public-spec.ts was lost that
// way). Tests here use the dot form only, so only that form is excluded.
const DASHED_TEST_GLOB = "**/*{.,-}{test,spec}?(-d).?(c|m)[jt]s?(x)";
const DOT_TEST_GLOB = "**/*.{test,spec}?(-d).?(c|m)[jt]s?(x)";

/**
 * Coverage is measured over product code only, and honestly (decision 13.1):
 * every file under src counts, including the ones no test loads (`all`), so
 * an untested module shows up as 0% instead of disappearing from the total.
 *
 * Nothing that holds logic is excluded. The only files left out are the ones
 * Vitest already skips by default (tests, *.d.ts, configs) — kept by
 * mapping the defaults, since an `exclude` array replaces them instead of
 * extending them. src/@types holds only *.d.ts, so the default covers it.
 *
 * The unit run writes coverage/unit; COVERAGE_DIR lets the E2E batches
 * (infra/scripts/coverage-e2e.sh) each write their own report before
 * infra/scripts/merge-coverage.mjs joins them into coverage/all.
 *
 * The E2E phases (`yarn test:e2e`, infra/scripts/run-e2e.mjs): the files
 * that start API replicas as processes of their own run in a phase of their
 * own, one file at a time, after the rest (tests/E2E/support/replica-files.ts
 * has the list and the why). E2E_PHASE picks the phase; without it —
 * `npx vitest run <file>`, the unit suite — every file is included as before.
 */
const E2E_PHASE = process.env.E2E_PHASE;

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    ...(E2E_PHASE === E2E_PHASE_SHARED && {
      exclude: [...configDefaults.exclude, ...replicaFileGlobs()],
    }),
    ...(E2E_PHASE === E2E_PHASE_REPLICAS && {
      include: replicaFileGlobs(),
      fileParallelism: false,
    }),
    coverage: {
      provider: "v8",
      all: true,
      include: ["src/**/*.ts"],
      exclude: coverageConfigDefaults.exclude.map((glob) =>
        glob === DASHED_TEST_GLOB ? DOT_TEST_GLOB : glob,
      ),
      reporter: ["text-summary", "json-summary", "json", "lcov", "html"],
      reportsDirectory: process.env.COVERAGE_DIR ?? "coverage/unit",
      // A red test must not also hide the measurement: the CI step still
      // fails on the test, and the published report shows what did run.
      reportOnFailure: true,
    },
    environmentMatchGlobs: [["./tests/E2E/**", "prisma"]],
    // A process per test file, unit and E2E alike: no two files share a
    // process, so none shares native state or a teardown with another.
    // Under the threads pool (one process, a worker thread per file) the
    // whole run died, with nothing printed, as exit 127: the E2E files under
    // Prisma 6 ("failed to delete napi ref"), and on 30/10/2026 the unit
    // suite on Windows, 3 runs in 10, each logged by Windows as a heap
    // corruption of node.exe (0xc0000374). With forks: 0 in 8, in the same
    // time. Forks is Vitest 2's default for the same reason.
    pool: "forks",
    setupFiles: ["./setupTests.ts"], // add reflect metadata for all tests
  },
});
