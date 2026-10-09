import { configDefaults, defineConfig } from "vitest/config";

import base from "./vite.config.mjs";

/**
 * Tests left out of the mutation run, each for a reason unrelated to the
 * mutated code (none of them is what kills a mutant of stryker.config.mjs).
 */
const NOT_IN_MUTATION_RUN = [
  // Scans src/ for `setHours(0,0,0,0)`-style day math. Stryker rewrites every
  // mutated file with its instrumentation, which the scan then reports.
  "tests/unitaires/time/no-server-day-math.test.ts",
  // Compares the web portal's copy of the OpenAPI document with the live one;
  // red outside the sandbox too until that copy is regenerated
  // (UPDATE_PUBLIC_OPENAPI_FIXTURE=1), and it mutates nothing of ours.
  "tests/unitaires/integration/public-docs-guide-samples.test.ts",
];

/**
 * The test set Stryker runs against each mutant (stryker.config.mjs).
 *
 * The unit suite only: Stryker drives one Vitest process, and the E2E suite
 * cannot run in one process on every host (the Prisma engine panics past
 * ~12 files), besides needing a database per file. MUTATION_TESTS narrows it
 * further (comma-separated globs), for a focused run on one file. A
 * MUTATION_BATCH run does not set it: its dry run takes the whole unit suite
 * and perTest coverage then picks, per mutant, the tests that reached it.
 */
// Spread, not mergeConfig: mergeConfig concatenates arrays, so the base
// `include` would survive and the narrowing would do nothing.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: (process.env.MUTATION_TESTS ?? "tests/unitaires/**/*.test.ts").split(","),
    exclude: [...configDefaults.exclude, ...NOT_IN_MUTATION_RUN],
  },
});
