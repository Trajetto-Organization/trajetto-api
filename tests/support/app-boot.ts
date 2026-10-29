/**
 * How long a test may take to boot the whole API: `import("@/http")`, then
 * `app.ready()` and, for the documentation checks, `app.swagger()`.
 *
 * One number for every test that does it, because it is the same work in all
 * of them and its cost is not theirs: it grows with the application's module
 * graph and with how many sibling files boot the app at the same moment.
 * About twenty unit files do, and they start together at the head of the
 * parallel run, each evaluating the full graph in its own worker.
 *
 * Measured on the development machine (16 logical cores), 29/09/2026:
 * - one file alone: ~14 s, most of it module loading (`ready()` ~0.5 s,
 *   `swagger()` ~0.4 s);
 * - the full unit suite on a quiet machine: 22–42 s per booting file;
 * - the full suite next to a typecheck: up to 95 s, and a hook budgeted at
 *   60 s timed out while its twin at 120 s passed.
 *
 * It only catches a boot that hangs. Nothing here asserts boot latency, so
 * a tighter budget buys no coverage and fails whenever the host is busy.
 */
export const APP_BOOT_TIMEOUT_MS = 120_000;
