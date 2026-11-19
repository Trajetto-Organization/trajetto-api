import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  INFRA_URL_VARIABLES,
  infraUrl,
} from "../../E2E/infra/support/infra-urls";
import {
  E2E_PHASE_INFRA,
  E2E_PHASE_REPLICAS,
  E2E_PHASE_SHARED,
  INFRA_E2E_GLOB,
  REPLICA_E2E_FILES,
  SERIAL_E2E_FILES,
  replicaFileGlobs,
} from "../../E2E/support/replica-files";
import {
  conditionOf,
  jobOf,
  readWorkflow,
  stepNames,
  stepOf,
} from "../lifecycle/support/workflow-text";

/**
 * The E2E infra phase (plano-escala F4-38) runs apart, on a stack of its
 * own, and never passes by skipping.
 *
 * Its files (tests/E2E/infra) measure a real PgBouncer and a real standby
 * that tests/E2E/infra/run.sh starts for them. They give roles a login and
 * hold a replication slot, which belong to the whole cluster: in the
 * shared phase, on the shared test cluster, they would change what every
 * other file sees, and without the stack they have nothing to test. So:
 * only in their phase, one file at a time, only against the stack's URLs,
 * failing when one is missing; and in the CI, in job 1, after its slice.
 */
const ROOT = resolve(__dirname, "..", "..", "..");
const INFRA = join(ROOT, "tests", "E2E", "infra");
const RUN = "tests/E2E/infra/run.sh";
const vitestRequire = createRequire(
  createRequire(join(ROOT, "package.json")).resolve("vitest"),
);
const mm = vitestRequire("micromatch") as {
  isMatch: (file: string, glob: string | string[]) => boolean;
};

const read = (path: string) =>
  readFileSync(join(ROOT, path), "utf8").replace(/\r\n/g, "\n");
const infraFiles = readdirSync(INFRA)
  .filter((name) => name.endsWith(".test.ts"))
  .sort();
const topLevelFiles = readdirSync(join(ROOT, "tests", "E2E")).filter((name) =>
  name.endsWith(".test.ts"),
);

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

describe("the infra phase's files", () => {
  it("exist, the PgBouncer and the standby ones among them", () => {
    expect(infraFiles).toEqual(
      expect.arrayContaining([
        "pgbouncer-transaction-mode.test.ts",
        "streaming-standby.test.ts",
      ]),
    );
  });

  it("match the phase's glob, with or without --dir ./tests/E2E, and nothing else does", () => {
    for (const name of infraFiles) {
      expect(mm.isMatch(`infra/${name}`, INFRA_E2E_GLOB), name).toBe(true);
      expect(mm.isMatch(`tests/E2E/infra/${name}`, INFRA_E2E_GLOB), name).toBe(
        true,
      );
    }

    for (const name of topLevelFiles) {
      expect(mm.isMatch(name, INFRA_E2E_GLOB), name).toBe(false);
      expect(mm.isMatch(`tests/E2E/${name}`, INFRA_E2E_GLOB), name).toBe(false);
    }
  });

  it("share no name with the one-file-at-a-time phase, whose globs match by name", () => {
    const serial = new Set<string>([...REPLICA_E2E_FILES, ...SERIAL_E2E_FILES]);

    expect(infraFiles.filter((name) => serial.has(name))).toEqual([]);

    for (const name of infraFiles) {
      expect(
        mm.isMatch(`tests/E2E/infra/${name}`, replicaFileGlobs()),
        name,
      ).toBe(false);
    }
  });

  it("run without a database of the shared cluster, and reach the stack only through infraUrl", () => {
    for (const name of infraFiles) {
      const source = read(`tests/E2E/infra/${name}`);

      // The comment wins over environmentMatchGlobs: no clone of the
      // shared test cluster's template for these files.
      expect(source.startsWith("// @vitest-environment node\n"), name).toBe(
        true,
      );
      expect(source, name).toContain('from "./support/infra-urls"');
      expect(source, name).not.toMatch(
        /\b(?:TEST_DATABASE_URL|DATABASE_URL|REDIS_URL)\b/,
      );
      expect(source, name).not.toMatch(/process\.env/);
    }
  });

  it("never skip: a missing stack is a failure", () => {
    for (const name of infraFiles) {
      expect(read(`tests/E2E/infra/${name}`), name).not.toMatch(
        /\.(?:skip|skipIf|runIf|todo|only)\b/,
      );
    }
  });
});

describe("infraUrl", () => {
  const stack = {
    E2E_INFRA_PRIMARY_URL: "postgresql://postgres:x@127.0.0.1:49001/trajetto",
    E2E_INFRA_STANDBY_URL: "postgresql://postgres:x@127.0.0.1:49002/trajetto",
    E2E_INFRA_PGBOUNCER_URL:
      "postgresql://trajetto_http:x@127.0.0.1:49003/trajetto",
    E2E_INFRA_PGBOUNCER_STATS_URL:
      "postgresql://pgbouncer_stats:x@127.0.0.1:49003/pgbouncer",
    DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/test_db",
  };

  it("gives each endpoint its variable's URL", () => {
    expect(infraUrl("primary", stack)).toBe(stack.E2E_INFRA_PRIMARY_URL);
    expect(infraUrl("standby", stack)).toBe(stack.E2E_INFRA_STANDBY_URL);
    expect(infraUrl("pgbouncer", stack)).toBe(stack.E2E_INFRA_PGBOUNCER_URL);
    expect(infraUrl("pgbouncerStats", stack)).toBe(
      stack.E2E_INFRA_PGBOUNCER_STATS_URL,
    );
  });

  it("fails without the URL, empty or blank alike, and names the command", () => {
    for (const [endpoint, variable] of Object.entries(INFRA_URL_VARIABLES)) {
      for (const value of [undefined, "", "   "]) {
        expect(
          () =>
            infraUrl(endpoint as keyof typeof INFRA_URL_VARIABLES, {
              ...stack,
              [variable]: value,
            }),
          `${variable}=${String(value)}`,
        ).toThrow(
          new RegExp(`${variable} não está definida.*yarn test:e2e:infra`),
        );
      }
    }
  });

  it("refuses a URL that is not one, or that leaves the machine", () => {
    expect(() =>
      infraUrl("primary", { ...stack, E2E_INFRA_PRIMARY_URL: "not a url" }),
    ).toThrow(/não é uma URL válida/);

    for (const host of ["api-staging.example.com", "192.0.2.10", "db"]) {
      expect(
        () =>
          infraUrl("pgbouncer", {
            ...stack,
            E2E_INFRA_PGBOUNCER_URL: `postgresql://trajetto_http:x@${host}:6432/trajetto`,
          }),
        host,
      ).toThrow(/só roda contra a pilha descartável/);
    }
  });

  it("refuses the shared test cluster, TEST_DATABASE_URL first", () => {
    expect(() =>
      infraUrl("primary", {
        ...stack,
        E2E_INFRA_PRIMARY_URL: "postgresql://postgres:x@localhost/trajetto",
      }),
    ).toThrow(/cluster de teste compartilhado \(localhost:5432\)/);

    expect(() =>
      infraUrl("standby", {
        ...stack,
        TEST_DATABASE_URL: "postgresql://postgres:x@127.0.0.1:49002/other",
      }),
    ).toThrow(/cluster de teste compartilhado \(127\.0\.0\.1:49002\)/);
  });
});

describe("the phases", () => {
  it("leaves the infra files out of the shared phase", async () => {
    const test = await configFor(E2E_PHASE_SHARED);

    expect(test.exclude).toEqual(expect.arrayContaining([INFRA_E2E_GLOB]));
  });

  it("keeps the replicas phase to its own list", async () => {
    const test = await configFor(E2E_PHASE_REPLICAS);

    expect(test.include).toEqual(replicaFileGlobs());
  });

  it("runs only the infra files in the infra phase, one file at a time", async () => {
    const test = await configFor(E2E_PHASE_INFRA);

    expect(test.include).toEqual([INFRA_E2E_GLOB]);
    expect(test.fileParallelism).toBe(false);
  });
});

describe("yarn test:e2e:infra (tests/E2E/infra/run.sh)", () => {
  const script = read(RUN);
  const lines = script.split("\n");

  it("is the package script, and runs the infra phase after the stack is up", () => {
    const scripts = JSON.parse(read("package.json")).scripts;

    expect(scripts["test:e2e:infra"]).toBe(`bash ${RUN}`);
    expect(script).toMatch(
      /\nE2E_PHASE=infra node \.\/node_modules\/vitest\/vitest\.mjs run --dir \.\/tests\/E2E "\$@"\n$/,
    );

    for (const variable of Object.values(INFRA_URL_VARIABLES)) {
      expect(script, variable).toMatch(new RegExp(`\\nexport ${variable}=`));
    }

    expect(script.indexOf('healthy "$BOUNCER"')).toBeLessThan(
      script.indexOf("E2E_PHASE=infra"),
    );
    expect(script.indexOf("streaming\n")).toBeLessThan(
      script.indexOf("E2E_PHASE=infra"),
    );
  });

  it("names, labels and publishes on the loopback everything it starts", () => {
    const runs = script.split("docker run -d ").slice(1);

    expect(runs).toHaveLength(3);

    for (const run of runs) {
      expect(run).toMatch(/^--name "\$(?:PRIMARY|STANDBY|BOUNCER)"/);
      expect(run).toContain('--label "$LABEL"');
      expect(run).toContain('--network "$NETWORK"');
      expect(run).toMatch(/-p 127\.0\.0\.1::\d+ /);
    }

    expect(script).toContain('docker network create --label "$LABEL"');
    expect(script).toMatch(/\nPRIMARY=\$\{PREFIX\}primary\n/);
    expect(script).toMatch(/\nSTANDBY=\$\{PREFIX\}standby\n/);
    expect(script).toMatch(/\nBOUNCER=\$\{PREFIX\}pgbouncer\n/);
    expect(script).toMatch(/\nNETWORK=\$\{PREFIX\}net\n/);
  });

  it("removes only what carries its label, and never names a shared container", () => {
    const removal = script.slice(
      script.indexOf("remove_stack() {"),
      script.indexOf("cleanup() {"),
    );

    expect(removal).toMatch(
      /label=\$\(label_of container "\$name"\) \|\| continue\n\s+\[ "\$label" = "\$PURPOSE" \] \|\|\n\s+die /,
    );
    expect(
      lines.filter((line) => /docker (?:rm|network rm)\b/.test(line)),
    ).toHaveLength(2);

    for (const shared of [
      "trajetto-database",
      "trajetto-redis",
      "trajetto-itest-pg",
      "trajetto-test-redis",
      "trajetto-resil-pg",
    ]) {
      expect(
        lines.filter((line) => !line.startsWith("#")).join("\n"),
        shared,
      ).not.toContain(shared);
    }
  });

  it("gives replication to the stack's network only, never 'all'", () => {
    expect(script).toContain(
      'printf "host replication trajetto_replication %s scram-sha-256\\n" "$1"',
    );
    expect(script).not.toMatch(/host\s+replication\s+\S+\s+all\b/);
  });
});

describe("the CI", () => {
  const validate = readWorkflow("validate.yml");
  const e2e = jobOf(validate, "e2e");
  const names = stepNames(e2e);
  const only =
    /^\$\{\{ !cancelled\(\) && matrix\.shard == 1 && steps\.e2e\.outcome != 'skipped' \}\}$/;

  it("runs the infra phase in job 1 only, after its slice, even when the slice failed", () => {
    const run = stepOf(e2e, "Run the E2E infra phase (PgBouncer and standby)");

    expect(conditionOf(run)).toMatch(only);
    expect(run.run).toContain("yarn test:e2e:infra --run --reporter=basic");
    expect(run.text).toContain(
      "E2E_INFRA_PGBOUNCER_IMAGE: trajetto-pgbouncer:e2e-infra",
    );
    expect(stepOf(e2e, "Run E2E tests").text).toMatch(/\n\s+id: e2e\n/);
    expect(names.indexOf("Run E2E tests")).toBeLessThan(
      names.indexOf("Run the E2E infra phase (PgBouncer and standby)"),
    );
  });

  it("builds the PgBouncer of this commit for it, loaded and never pushed", () => {
    const build = stepOf(e2e, "Build the PgBouncer image for the infra phase");

    expect(conditionOf(build)).toMatch(only);
    expect(
      conditionOf(stepOf(e2e, "Set up Docker Buildx (infra phase)")),
    ).toMatch(only);
    expect(build.text).toContain("context: ./infra/pgbouncer");
    expect(build.text).toContain("push: false");
    expect(build.text).toContain("load: true");
    expect(build.text).toContain("tags: trajetto-pgbouncer:e2e-infra");
    expect(
      names.indexOf("Build the PgBouncer image for the infra phase"),
    ).toBeLessThan(
      names.indexOf("Run the E2E infra phase (PgBouncer and standby)"),
    );
  });
});

describe("the E2E coverage batches", () => {
  it("leave the infra files out: they need the stack", () => {
    expect(read("infra/scripts/coverage-e2e.sh")).toContain(
      "find tests/E2E -path tests/E2E/infra -prune -o -name '*.test.ts' -print",
    );
  });
});
