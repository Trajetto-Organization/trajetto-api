import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  E2E_PHASE_REPLICAS,
  E2E_PHASE_SHARED,
  REPLICA_E2E_FILES,
  SERIAL_E2E_FILES,
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

/**
 * What makes a file wait on the cluster's xmin horizon. Before it settles a
 * changed day, the dashboard's rollup (plano-escala F4-21) waits for every
 * write transaction open ANYWHERE in the cluster when it started: in the
 * parallel phase, a writer another file keeps open in its own database (a
 * lock or 55P03 test, a bulk seed) holds the wait past the 5 s test timeout,
 * a red that a run alone never shows. The job's entry point waits only when
 * a mark is pending; a file that runs it before any delivery changes, as
 * dashboard-rollup-equivalence does, never waits.
 */
const WAITS_ON_THE_HORIZON = [
  /\brollUpTenantDays\(/,
  /\.settledSince\(/,
  /\bpg_current_snapshot\(/,
  /\bpg_snapshot_xmin\(/,
];

/** The file and the shared suites it runs (../contract): their cases run in it. */
function sourceWithSuites(name: string): string {
  const source = readFileSync(join(E2E, name), "utf8");
  const suites = [...source.matchAll(/from "(\.\.\/contract\/[^"]+)"/g)].map(
    ([, path]) => readFileSync(`${resolve(E2E, path)}.ts`, "utf8"),
  );

  return [source, ...suites].join("\n");
}

function waitsOnTheHorizon(name: string): boolean {
  const source = sourceWithSuites(name);

  return WAITS_ON_THE_HORIZON.some((pattern) => pattern.test(source));
}

/**
 * The files that measure what the whole cluster disturbs (the xmin horizon
 * every database shares, plano-escala F2-13) run in the same
 * one-file-at-a-time phase, without starting replicas.
 */
describe("the cluster-sensitive files", () => {
  it("exist and run in the one-file-at-a-time phase", () => {
    for (const name of SERIAL_E2E_FILES) {
      expect(e2eFiles, name).toContain(name);
      expect(mm.isMatch(`tests/E2E/${name}`, replicaFileGlobs()), name).toBe(
        true,
      );
    }
  });

  it("has every file that waits on the cluster's xmin horizon", () => {
    const missing = e2eFiles.filter(
      (name) =>
        waitsOnTheHorizon(name) &&
        !(SERIAL_E2E_FILES as readonly string[]).includes(name),
    );

    expect(missing).toEqual([]);
  });

  /**
   * A gate on the planner's own clock ("Planning Time" of an EXPLAIN) is
   * wall-clock CPU: beside the parallel phase's other forks, on a runner
   * of two to four cores, the same plan read 60 % slower than alone (the
   * partitioned queues' webhook claim, 1.3 ms alone, 2.19 ms in E2E 1/3
   * with its statement unchanged), over its 2 ms gate.
   */
  it("has every file that gates on the planner's clock", () => {
    const missing = e2eFiles.filter(
      (name) =>
        /"Planning Time"/.test(sourceWithSuites(name)) &&
        !(SERIAL_E2E_FILES as readonly string[]).includes(name),
    );

    expect(missing).toEqual([]);
  });

  /**
   * So is a gate on the slowest of a series of timed statements (each
   * sample pushed as Date.now() minus its start): the partition job's
   * pings while its ATTACH waits took at most 9 ms alone and up to 146 ms
   * in E2E 1/3, a gradual tail of CPU contention, not a lock wait, over
   * its 100 ms gate.
   */
  it("has every file that gates on the slowest of its timed samples", () => {
    const missing = e2eFiles.filter(
      (name) =>
        /\.push\(Date\.now\(\) - \w+\)/.test(sourceWithSuites(name)) &&
        !(SERIAL_E2E_FILES as readonly string[]).includes(name),
    );

    expect(missing).toEqual([]);
  });

  it("tells a file that waits on the horizon from one that only runs the job", () => {
    expect(waitsOnTheHorizon("tenant-day-rollup.test.ts")).toBe(true);
    expect(
      waitsOnTheHorizon("tenant-day-rollup-repository-contract.test.ts"),
    ).toBe(true);
    expect(waitsOnTheHorizon("dashboard-rollup-equivalence.test.ts")).toBe(
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
