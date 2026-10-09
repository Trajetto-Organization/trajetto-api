// Mutation testing of the critical rules (decision 13.5): authorization,
// tenant, state machines, idempotency, pagination, business day.
//
// @stryker-mutator 8.7 is the last line whose Vitest runner accepts Vitest 1.x
// (9.0 requires Vitest >= 2); pinned so the runner and the suite stay in step.
//
// Run: MUTATION_BATCH=<guards|states|outbox|lists> yarn test:mutation, one
// batch at a time (each fits in ~45 min on a 16-thread host); without
// MUTATION_BATCH every batch runs in one go. Needs the test DATABASE_URL and
// REDIS_URL because part of the unit suite touches them.
// Smoke / one file: MUTATION_TESTS=<test globs> yarn test:mutation --mutate <file>
/**
 * The mutated files, by area. A batch keeps one report per area, so a rerun
 * after a fix only pays for the area it touched.
 */
const BATCHES = {
  // Authorization and tenant: whoever is let through.
  guards: [
    "src/modules/middlewares/**/*.ts",
    "src/shared/entitlements/entitlement-rules.ts",
    "src/modules/chat/usecases/shared/chat-access-rules.ts",
    "src/shared/security/login-lockout-rules.ts",
    "src/shared/security/two-factor-rules.ts",
    "src/shared/integration/api-key-rules.ts",
  ],
  // State machines.
  states: [
    "src/shared/delivery/delivery-rules.ts",
    "src/shared/route/route-rules.ts",
    "src/shared/route/operation-day-rules.ts",
    "src/modules/chat/usecases/shared/ticket-rules.ts",
    "src/modules/driver-pause/rules/pause-rules.ts",
    "src/modules/driver-pause/rules/pause-journey-rules.ts",
  ],
  // Idempotency, submission keys, the outbox and the claim/retry rules of
  // the Postgres-backed queues.
  outbox: [
    "src/shared/http/idempotency-key.ts",
    "src/shared/http/submission-key.ts",
    "src/modules/integration/usecases/create-delivery/integration-idempotency-key.ts",
    "src/shared/notifications/outbox-service.ts",
    "src/shared/notifications/pipeline-rules.ts",
    "src/shared/integration/webhook-dispatch-rules.ts",
  ],
  // List-query parsing, pagination and the business day.
  lists: ["src/shared/pagination/**/*.ts", "src/shared/time/business-day.ts"],
};

const batch = process.env.MUTATION_BATCH;

if (batch && !(batch in BATCHES)) {
  throw new Error(`MUTATION_BATCH must be one of ${Object.keys(BATCHES).join(", ")}`);
}

const reportDir = batch ? `reports/mutation/${batch}` : "reports/mutation";

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  vitest: { configFile: "vitest.mutation.config.mts" },
  // Each mutant runs only the tests that executed its code in the dry run.
  coverageAnalysis: "perTest",
  mutate: batch ? BATCHES[batch] : Object.values(BATCHES).flat(),
  // A static mutant (module-level constant) has no per-test coverage, so it
  // reruns the whole ~430-file unit suite: 300 of them were an ~8 h tail in
  // the 06/10 run. Skipped in the wide run; the tables they touch are
  // measured by the focused run below (docs/qualidade/cobertura-e-mutacao.md §4.2).
  // MUTATION_STATIC=1 keeps them, for a focused pass on one file with its
  // own tests (MUTATION_TESTS): the runner attributes a static mutant to the
  // first test that loaded the module, so with ignoreStatic it may be tried
  // against that one test only and reported Survived wrongly.
  ignoreStatic: process.env.MUTATION_STATIC !== "1",
  // Not copied into the sandbox: reports, uploads and suites Stryker never runs.
  ignorePatterns: ["coverage", "reports", "tmp", "tests/E2E", "tests/load", "tests/ai-local", "infra/ai-ocr", "docs"],
  reporters: ["clear-text", "progress", "html", "json"],
  htmlReporter: { fileName: `${reportDir}/index.html` },
  jsonReporter: { fileName: `${reportDir}/mutation.json` },
  // break 90: the 06/10/2026 run scored API 96.17, web 96.53, app 97.16
  // (docs/qualidade/cobertura-e-mutacao.md §4.4); 90 leaves a margin and
  // fails a run that loses a real share of the killed mutants.
  thresholds: { high: 90, low: 75, break: 90 },
  tempDirName: ".stryker-tmp",
  // 16 logical CPUs shared with the editor and Docker: 6 runners stay under ~4 GB.
  concurrency: 6,
  timeoutMS: 20000,
  // The dry run executes ~430 unit files in one Vitest process; 5 min (default) is not enough on a loaded host.
  dryRunTimeoutMinutes: 30,
};
