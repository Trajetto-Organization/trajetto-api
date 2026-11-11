import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { BaseSequencer } from "vitest/node";
import { describe, expect, it } from "vitest";

import {
  E2E_PHASE_REPLICAS,
  E2E_PHASE_SHARED,
  REPLICA_E2E_FILES,
} from "../../E2E/support/replica-files";

/**
 * The CI's E2E jobs (validate.yml, `E2E (i/n)`) run the whole suite, each
 * file exactly once.
 *
 * Each job runs `yarn test:e2e` with E2E_SHARD=<i>/<n> (run-e2e.mjs): jobs
 * 1 to n−1 take a slice of the shared phase through vitest's own `--shard`,
 * and job n the replica phase whole. The slices are cut here by vitest's
 * own sequencer (BaseSequencer.shard: the files sorted by the sha1 of their
 * path from the root, in equal slices), over the files the shared phase
 * runs. A matrix that left a job empty fails in CI ("No test files found"),
 * and one that dropped a file would pass green without it: both fail here.
 */
const ROOT = resolve(__dirname, "..", "..", "..");
const slash = (path: string) => path.replace(/\\/g, "/");

const all = readdirSync(join(ROOT, "tests", "E2E"))
  .filter((name) => name.endsWith(".test.ts"))
  .sort();
const replicas = new Set<string>(REPLICA_E2E_FILES);
const shared = all.filter((name) => !replicas.has(name));

/** The shard numbers of validate.yml's E2E matrix. */
function matrix(): number[] {
  const workflow = readFileSync(
    join(ROOT, ".github", "workflows", "validate.yml"),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const list = /\n {8}shard: \[([\d, ]+)\]\n/.exec(workflow)?.[1] ?? "";

  return list
    .split(",")
    .map((each) => Number(each.trim()))
    .filter((each) => each > 0);
}

type Phases = (
  args: string[],
  shard?: string,
) => Array<{ phase: string; args: string[] }>;

async function phases(): Promise<Phases> {
  const module = (await import(
    pathToFileURL(join(ROOT, "infra", "scripts", "run-e2e.mjs")).href
  )) as { e2ePhases: Phases };

  return module.e2ePhases;
}

/** What vitest's --shard=<index>/<count> keeps of `files`. */
async function slice(
  files: string[],
  index: number,
  count: number,
): Promise<string[]> {
  const root = slash(ROOT);
  const sequencer = new BaseSequencer({
    config: { root, shard: { index, count } },
  } as never);
  const specs = files.map((name) => [{}, `${root}/tests/E2E/${name}`]);
  const kept = (await sequencer.shard(specs as never)) as unknown as Array<
    [unknown, string]
  >;

  return kept.map(([, file]) => file.slice(`${root}/tests/E2E/`.length));
}

/** The files job `index` of `count` runs. */
async function jobFiles(index: number, count: number): Promise<string[]> {
  const run = await phases();
  const files: string[] = [];

  for (const { phase, args } of run(
    ["--run", "--reporter=basic"],
    `${index}/${count}`,
  )) {
    const pool = phase === E2E_PHASE_SHARED ? shared : [...replicas];
    const shard = args
      .map((arg) => /^--shard=(\d+)\/(\d+)$/.exec(arg))
      .find(Boolean);

    files.push(
      ...(shard ? await slice(pool, Number(shard[1]), Number(shard[2])) : pool),
    );
  }

  return files;
}

describe("the E2E jobs of the CI", () => {
  it("are numbered 1 to n in validate.yml, with at least two", () => {
    const shards = matrix();

    expect(shards.length).toBeGreaterThanOrEqual(2);
    expect(shards).toEqual(shards.map((_, at) => at + 1));
  });

  it("run every E2E file exactly once, and none is empty", async () => {
    const count = matrix().length;
    const jobs = await Promise.all(
      matrix().map((index) => jobFiles(index, count)),
    );

    for (const [at, files] of jobs.entries()) {
      expect(files.length, `E2E (${at + 1}/${count})`).toBeGreaterThan(0);
    }

    const ran = jobs.flat();

    expect(new Set(ran).size, "no file in two jobs").toBe(ran.length);
    expect([...ran].sort()).toEqual(all);
  });

  it("keep the replica phase whole, in the last job and alone", async () => {
    const count = matrix().length;
    const run = await phases();

    expect(run(["--run"], `${count}/${count}`)).toEqual([
      {
        phase: E2E_PHASE_REPLICAS,
        args: ["run", "--dir", "./tests/E2E", "--run"],
      },
    ]);
    expect([...(await jobFiles(count, count))].sort()).toEqual(
      [...replicas].sort(),
    );

    for (let index = 1; index < count; index += 1) {
      expect(run(["--run"], `${index}/${count}`)).toEqual([
        {
          phase: E2E_PHASE_SHARED,
          args: [
            "run",
            "--dir",
            "./tests/E2E",
            "--run",
            `--shard=${index}/${count - 1}`,
          ],
        },
      ]);
    }
  });

  it("split the shared phase into slices of nearly the same size", async () => {
    const count = matrix().length;
    const slices = count - 1;
    const sizes = await Promise.all(
      Array.from({ length: slices }, (_, at) =>
        jobFiles(at + 1, count).then((files) => files.length),
      ),
    );

    // Vitest cuts ceil(files / slices) per slice: the last one may be short
    // by up to one file per other slice.
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(
      slices - 1,
    );
  });

  it("is the whole suite in both phases without a shard, or with 1/1", async () => {
    const run = await phases();
    const whole = [
      {
        phase: E2E_PHASE_SHARED,
        args: ["run", "--dir", "./tests/E2E", "--run"],
      },
      {
        phase: E2E_PHASE_REPLICAS,
        args: ["run", "--dir", "./tests/E2E", "--run"],
      },
    ];

    expect(run(["--run"], "")).toEqual(whole);
    expect(run(["--run"], "1/1")).toEqual(whole);
  });

  it("refuses a shard it cannot place", async () => {
    const run = await phases();

    for (const shard of ["0/3", "4/3", "3", "1/0", "a/b", "1/3 "]) {
      expect(() => run(["--run"], shard), shard).toThrow(/E2E_SHARD/);
    }
  });
});
