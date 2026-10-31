import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  E2E_PHASE_REPLICAS,
  E2E_PHASE_SHARED,
  REPLICA_E2E_FILES,
  replicaFileGlobs,
} from "../../E2E/support/replica-files";

/**
 * The E2E files that start API replicas run apart from the rest.
 *
 * A replica is one to three Node processes Vitest does not count. Beside the
 * rest of the suite on the 4-vCPU runner (public repositories since
 * 30/10/2026), they amplified the load on every file that waits on timing.
 * `yarn test:e2e` therefore runs them in a phase of their own, one at a time,
 * after the others (infra/scripts/run-e2e.mjs + vite.config.mts).
 *
 * The split is only as good as its list: a new file that starts replicas and
 * is not listed runs in the shared phase again, and nothing else would say so.
 */
const ROOT = resolve(__dirname, "..", "..", "..");
const E2E = join(ROOT, "tests", "E2E");

const vitestRequire = createRequire(
  createRequire(join(ROOT, "package.json")).resolve("vitest"),
);
const mm = vitestRequire("micromatch") as {
  isMatch: (file: string, glob: string | string[]) => boolean;
};

/** What makes a file start replicas: the two harnesses, or a spawn of its own. */
const STARTS_REPLICAS = [
  /from "\.\/support\/pipeline-replica-process"/,
  /from "\.\/support\/replica-process"/,
  /\bspawn\(/,
];

function startsReplicas(name: string): boolean {
  const source = readFileSync(join(E2E, name), "utf8");

  return STARTS_REPLICAS.some((pattern) => pattern.test(source));
}

const e2eFiles = readdirSync(E2E).filter((name) => name.endsWith(".test.ts"));

async function configFor(phase: string | undefined) {
  vi.resetModules();

  if (phase === undefined) delete process.env.E2E_PHASE;
  else process.env.E2E_PHASE = phase;

  const { default: config } = await import("../../../vite.config.mjs");

  return config.test ?? {};
}

const original = process.env.E2E_PHASE;

afterEach(() => {
  if (original === undefined) delete process.env.E2E_PHASE;
  else process.env.E2E_PHASE = original;
});

describe("the list of E2E files that start replicas", () => {
  it("names only files that exist and still start replicas", () => {
    for (const name of REPLICA_E2E_FILES) {
      expect(e2eFiles, name).toContain(name);
      expect(startsReplicas(name), name).toBe(true);
    }
  });

  it("has every file that starts replicas", () => {
    const missing = e2eFiles.filter(
      (name) =>
        startsReplicas(name) &&
        !(REPLICA_E2E_FILES as readonly string[]).includes(name),
    );

    expect(missing).toEqual([]);
  });

  it("matches its files with or without --dir ./tests/E2E", () => {
    for (const name of REPLICA_E2E_FILES) {
      expect(mm.isMatch(name, replicaFileGlobs()), name).toBe(true);
      expect(mm.isMatch(`tests/E2E/${name}`, replicaFileGlobs()), name).toBe(
        true,
      );
    }

    expect(mm.isMatch("route-lifecycle.test.ts", replicaFileGlobs())).toBe(
      false,
    );
  });
});

describe("the two phases", () => {
  it("leaves them out of the shared phase", async () => {
    const test = await configFor(E2E_PHASE_SHARED);

    expect(test.exclude).toEqual(expect.arrayContaining(replicaFileGlobs()));
    expect(test.include).toBeUndefined();
  });

  it("runs only them in the replicas phase, one file at a time", async () => {
    const test = await configFor(E2E_PHASE_REPLICAS);

    expect(test.include).toEqual(replicaFileGlobs());
    expect(test.fileParallelism).toBe(false);
  });

  it("changes nothing without a phase: a single file still runs as before", async () => {
    const test = await configFor(undefined);

    expect(test.include).toBeUndefined();
    expect(test.exclude).toBeUndefined();
    expect(test.fileParallelism).toBeUndefined();
  });

  it("is what yarn test:e2e runs: shared first, then replicas, with the same arguments", async () => {
    const scripts = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf8"),
    ).scripts;

    expect(scripts["test:e2e"]).toBe("node infra/scripts/run-e2e.mjs");

    const { e2ePhases } = (await import(
      pathToFileURL(join(ROOT, "infra", "scripts", "run-e2e.mjs")).href
    )) as {
      e2ePhases: (args: string[]) => Array<{ phase: string; args: string[] }>;
    };

    // The CI's call: no filter, so a phase that finds no file fails.
    expect(e2ePhases(["--run", "--reporter=basic"])).toEqual([
      {
        phase: E2E_PHASE_SHARED,
        args: ["run", "--dir", "./tests/E2E", "--run", "--reporter=basic"],
      },
      {
        phase: E2E_PHASE_REPLICAS,
        args: ["run", "--dir", "./tests/E2E", "--run", "--reporter=basic"],
      },
    ]);

    // A filter may match one phase only: the other then finds nothing.
    for (const { args } of e2ePhases(["route-lifecycle"])) {
      expect(args).toEqual([
        "run",
        "--dir",
        "./tests/E2E",
        "--passWithNoTests",
        "route-lifecycle",
      ]);
    }
  });
});
