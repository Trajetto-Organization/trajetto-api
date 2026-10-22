import { createRequire } from "node:module";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import config from "../../../vite.config.mjs";

/**
 * E2E files run one process each.
 *
 * Under the default threads pool every E2E file shared the runner process,
 * and Prisma's Node-API engine panicked when one worker was freed while the
 * others still held it ("failed to delete napi ref"): the whole batch died
 * with exit 127/139 even though every test had passed. Reproduced with
 * multi-replica-events next to any other E2E file; gone with forks.
 *
 * The match is checked with the same call Vitest 1.6 makes (micromatch over
 * the ABSOLUTE file path, glob not resolved against the root), because a
 * `./tests/E2E/**` glob reads right and silently matches nothing.
 */
const ROOT = resolve(__dirname, "..", "..", "..");

const vitestRequire = createRequire(
  createRequire(join(ROOT, "package.json")).resolve("vitest"),
);
const mm = vitestRequire("micromatch") as {
  isMatch: (file: string, glob: string, options: { cwd: string }) => boolean;
};

const poolFor = (relative: string): string => {
  const file = join(ROOT, relative).replace(/\\/g, "/");
  const globs = (config.test?.poolMatchGlobs ?? []) as [string, string][];

  for (const [glob, pool] of globs) {
    if (mm.isMatch(file, glob, { cwd: ROOT })) return pool;
  }

  return config.test?.pool ?? "threads";
};

describe("E2E pool configuration", () => {
  it("runs every E2E file in its own forked process", () => {
    expect(poolFor("tests/E2E/multi-replica-events.test.ts")).toBe("forks");
    expect(poolFor("tests/E2E/user-update-sessions.test.ts")).toBe("forks");
  });

  it("keeps unit files on the default threads pool", () => {
    expect(poolFor("tests/unitaires/quality/e2e-pool-config.test.ts")).toBe(
      "threads",
    );
  });
});
