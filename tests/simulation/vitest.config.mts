import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * The simulation's own unit tests (lib/geometry.ts, lib/clock.ts):
 *
 *   npx vitest run --config tests/simulation/vitest.config.mts
 *
 * Kept out of every CI run on purpose: the unit suite is
 * `vitest run --dir tests/unitaires`, the E2E suite `--dir ./tests/E2E` and the
 * AI job `tests/ai-local`, so nothing under tests/simulation is collected
 * there. The simulation itself is a manual tool (README.md).
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    include: ["tests/simulation/**/*.test.ts"],
    pool: "forks",
  },
});
