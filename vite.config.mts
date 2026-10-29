import { coverageConfigDefaults, defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

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
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
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
    // A process per E2E file. Chosen under Prisma 6: its Node-API engine
    // panicked ("failed to delete napi ref", exit 127/139) when E2E files
    // shared the default threads pool's process and a worker was freed while
    // others still held it. Prisma 7 has no native engine; forks stays until
    // threads is measured with it. A process per file has no shared teardown.
    poolMatchGlobs: [["**/tests/E2E/**", "forks"]],
    setupFiles: ["./setupTests.ts"], // add reflect metadata for all tests
  },
});
