import { createRequire } from "node:module";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import config from "../../../vite.config.mjs";

/**
 * Every test file runs in a process of its own (the forks pool).
 *
 * Under the threads pool the files shared the runner process, and the whole
 * run died with exit 127 and nothing printed: the E2E batch under Prisma 6
 * (its Node-API engine panicked when one worker was freed while others still
 * held it, "failed to delete napi ref"), and on 30/10/2026 the unit suite on
 * Windows, 3 full runs in 10, each one a heap corruption of node.exe
 * (0xc0000374) in the Windows event log. Forks: 0 in 8, in the same time
 * (docs/testes.md).
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

describe("pool configuration", () => {
  it("runs every E2E file in its own forked process", () => {
    expect(poolFor("tests/E2E/multi-replica-events.test.ts")).toBe("forks");
    expect(poolFor("tests/E2E/user-update-sessions.test.ts")).toBe("forks");
  });

  it("runs every unit file in its own forked process too", () => {
    expect(poolFor("tests/unitaires/quality/e2e-pool-config.test.ts")).toBe(
      "forks",
    );
    expect(poolFor("tests/unitaires/lifecycle/ghcr-script.test.ts")).toBe(
      "forks",
    );
  });
});
