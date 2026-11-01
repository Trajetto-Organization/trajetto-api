import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  hasShell,
  repoFile,
  run,
  sandbox,
  type Sandbox,
} from "./support/shell-harness";

/**
 * The images' boot script, run for real against stubbed build outputs.
 *
 * Every replica used to migrate and seed on boot, and the seeds' failures
 * were swallowed by `|| echo`. A broken seed (no MASTER_USER_EMAIL, a schema
 * error) went unnoticed while the system came up without its master user or
 * its violation codes; and a migration that failed or ran long left
 * `_prisma_migrations` in P3009, refusing the boot of EVERY image version
 * until someone ran `migrate resolve` by hand.
 *
 * Now a replica never migrates: `serve` waits for Postgres, refuses a
 * database without all of the build's migrations and execs the server. The
 * release step runs from the trajetto-api-migrate image, the only one with
 * the Prisma CLI: it migrates and seeds once, fails loudly, and never starts
 * the server — `migrate` then exits, `release` (the Dokploy Application's)
 * marks the step done for the image's healthcheck and idles.
 */
const sh = hasShell("sh");

let box: Sandbox;

/** A build/*.js stand-in that records itself, its arguments and its URL. */
const nodeStub = (name: string, exitVar: string) => `
require("node:fs").appendFileSync(
  process.env.STUB_LOG,
  ["${name}", ...process.argv.slice(2)].join(" ") +
    " DATABASE_URL=" + (process.env.DATABASE_URL ?? "") + "\\n",
);
process.exit(Number(process.env.${exitVar} ?? 0));
`;

/**
 * A Prisma CLI at `dir`/node_modules/.bin/prisma that records where it ran.
 * Executable, as in node_modules: Linux refuses to run it otherwise (126),
 * while Git for Windows' sh ignores the mode and hid the difference.
 */
function prismaCli(dir: string) {
  const prisma = box.file(
    `${dir}/node_modules/.bin/prisma`,
    `#!/bin/sh\nprintf '%s\\n' "prisma $* cwd=$(basename "$(pwd)") DATABASE_URL=$DATABASE_URL" >> "$STUB_LOG"\nexit "\${STUB_PRISMA_EXIT:-0}"\n`,
  );

  chmodSync(prisma, 0o755);
}

beforeEach(() => {
  box = sandbox();

  box.file(
    "build/wait-for-postgres.js",
    nodeStub("wait-for-postgres", "STUB_WAIT_EXIT"),
  );
  box.file("build/seed.js", nodeStub("seed", "STUB_SEED_EXIT"));
  box.file(
    "build/import-violation-codes.js",
    nodeStub("import-violation-codes", "STUB_IMPORT_EXIT"),
  );
  box.file("build/server.js", nodeStub("server", "STUB_SERVER_EXIT"));
});

afterEach(() => box.dispose());

function entrypoint(args: string[], env: Record<string, string> = {}) {
  const result = run(
    "sh",
    repoFile("infra/scripts/docker-entrypoint.sh"),
    args,
    {
      cwd: box.root,
      env: {
        STUB_LOG: box.log,
        DATABASE_URL: "postgresql://runtime",
        ...env,
      },
    },
  );

  const calls = readFileSync(box.log, "utf8").split("\n").filter(Boolean);
  const called = (what: string) => calls.some((line) => line.startsWith(what));

  return { ...result, calls, called };
}

describe.skipIf(!sh)("the release step (`migrate` mode)", () => {
  beforeEach(() => prismaCli("migrate"));

  it("migrates from migrate/ (the release image), seeds once, and never starts the server", () => {
    const { status, calls, called } = entrypoint(["migrate"]);

    expect(status, calls.join("\n")).toBe(0);
    expect(
      calls.find((line) => line.startsWith("prisma migrate deploy")),
    ).toContain("cwd=migrate");
    expect(called("seed ")).toBe(true);
    expect(called("import-violation-codes ")).toBe(true);
    expect(called("server ")).toBe(false);
  });

  it("does not ask the database for the build's migration: it is about to apply it", () => {
    const { calls } = entrypoint(["migrate"]);

    expect(
      calls.find((line) => line.startsWith("wait-for-postgres")),
    ).not.toContain("--require-migrations");
  });

  it("fails when a seed fails, instead of swallowing it", () => {
    const { status, called } = entrypoint(["migrate"], { STUB_SEED_EXIT: "1" });

    expect(status).not.toBe(0);
    expect(called("prisma migrate deploy")).toBe(true);
    expect(called("server ")).toBe(false);
  });

  it("fails when the violation-code import fails", () => {
    const { status, called } = entrypoint(["migrate"], {
      STUB_IMPORT_EXIT: "1",
    });

    expect(status).not.toBe(0);
    expect(called("server ")).toBe(false);
  });

  it("stops at a failed migration, before any seed", () => {
    const { status, called } = entrypoint(["migrate"], {
      STUB_PRISMA_EXIT: "1",
    });

    expect(status).not.toBe(0);
    expect(called("seed ")).toBe(false);
  });

  it("does nothing at all when the database is refused", () => {
    const { status, calls } = entrypoint(["migrate"], { STUB_WAIT_EXIT: "1" });

    expect(status).not.toBe(0);
    expect(calls).toEqual([expect.stringMatching(/^wait-for-postgres /)]);
  });
});

/**
 * The same step as the Dokploy Application trajetto-api-migrate runs it (the
 * release image's default command). A Swarm service has to keep running to
 * report success, so after the seeds it marks the step done — the marker the
 * image's HEALTHCHECK waits for — and idles; a failure exits, and Swarm
 * shows the task `Failed`. `rm`, `touch` and `tail` are stubbed: the marker
 * lives in the container's /tmp, and `tail -f` would never return.
 */
describe.skipIf(!sh)("the release step as an Application (`release` mode)", () => {
  const MARKER = "/tmp/trajetto-release-done";

  beforeEach(() => {
    prismaCli("migrate");
    box.stub("rm", "exit 0");
    box.stub("touch", "exit 0");
    box.stub("tail", "exit 0");
  });

  function release(env: Record<string, string> = {}) {
    const result = run(
      "sh",
      repoFile("infra/scripts/docker-entrypoint.sh"),
      ["release"],
      {
        cwd: box.root,
        bin: box.bin,
        env: { STUB_LOG: box.log, DATABASE_URL: "postgresql://runtime", ...env },
      },
    );
    const calls = readFileSync(box.log, "utf8").split("\n").filter(Boolean);

    return { ...result, calls };
  }

  it("clears a stale marker, migrates and seeds, then marks the step done and idles", () => {
    const { status, calls } = release();

    expect(status, calls.join("\n")).toBe(0);
    expect(calls).toEqual([
      `rm -f ${MARKER}`,
      expect.stringMatching(/^wait-for-postgres DATABASE_URL=/),
      expect.stringMatching(/^prisma migrate deploy cwd=migrate /),
      expect.stringMatching(/^seed DATABASE_URL=/),
      expect.stringMatching(/^import-violation-codes DATABASE_URL=/),
      `touch ${MARKER}`,
      "tail -f /dev/null",
    ]);
  });

  it.each([
    ["the database is refused", { STUB_WAIT_EXIT: "1" }],
    ["a migration fails", { STUB_PRISMA_EXIT: "1" }],
    ["a seed fails", { STUB_SEED_EXIT: "1" }],
    ["the violation-code import fails", { STUB_IMPORT_EXIT: "1" }],
  ])("exits without marking anything done when %s", (_case, env) => {
    const { status, calls } = release(env);

    expect(status).not.toBe(0);
    expect(calls).not.toContain(`touch ${MARKER}`);
    expect(calls).not.toContain("tail -f /dev/null");
    expect(calls.some((line) => line.startsWith("server "))).toBe(false);
  });

  it("is the mode the release image runs by default, and the marker its healthcheck reads", () => {
    const dockerfile = readFileSync(repoFile("Dockerfile"), "utf8");
    const stage = dockerfile.slice(dockerfile.indexOf("FROM runner AS migrate"));

    expect(stage).toContain(`CMD test -f ${MARKER}`);
    expect(stage).toContain('CMD ["./docker-entrypoint.sh", "release"]');
  });

  it("leaves the marker alone in `migrate` mode, which simply exits", () => {
    const { status, calls } = entrypoint(["migrate"]);

    expect(status).toBe(0);
    expect(readFileSync(box.log, "utf8")).not.toContain(MARKER);
    expect(calls).not.toContain("tail -f /dev/null");
  });
});

describe.skipIf(!sh)("where `migrate` finds the Prisma CLI", () => {
  it("in a checkout, the repository's own (yarn migrate:release)", () => {
    prismaCli(".");

    const { status, calls } = entrypoint(["migrate"]);

    expect(status, calls.join("\n")).toBe(0);
    expect(
      calls.find((line) => line.startsWith("prisma migrate deploy")),
    ).toMatch(/cwd=trajetto-sh-/);
  });

  it("in the API image, nowhere: it says which image migrates and touches nothing", () => {
    const { status, stderr, calls } = entrypoint(["migrate"]);

    expect(status).toBe(64);
    expect(stderr).toContain("trajetto-api-migrate");
    expect(calls).toEqual([]);
  });
});

describe.skipIf(!sh)("the boot (`serve`, the default)", () => {
  it("checks the build's migration, then serves", () => {
    const { status, calls } = entrypoint([]);

    expect(status, calls.join("\n")).toBe(0);
    expect(calls).toEqual([
      expect.stringMatching(
        /^wait-for-postgres --require-migrations build\/schema-version\.json /,
      ),
      expect.stringMatching(/^server /),
    ]);
  });

  it("never migrates nor seeds, even with a CLI around and the old switch set", () => {
    // RUN_MIGRATIONS_ON_BOOT is gone: an Application that still has it set
    // must not bring boot migrations back.
    prismaCli("migrate");
    prismaCli(".");

    const { status, called } = entrypoint([], {
      RUN_MIGRATIONS_ON_BOOT: "true",
    });

    expect(status).toBe(0);
    expect(called("prisma ")).toBe(false);
    expect(called("seed ")).toBe(false);
    expect(called("import-violation-codes ")).toBe(false);
    expect(called("server ")).toBe(true);
  });

  it("never starts the server over a database it refused", () => {
    // wait-for-postgres exits non-zero on a dead database, an empty one in
    // production, or one without the build's migration.
    const { status, called } = entrypoint([], { STUB_WAIT_EXIT: "1" });

    expect(status).not.toBe(0);
    expect(called("server ")).toBe(false);
  });

  it("refuses an unknown mode rather than guessing", () => {
    prismaCli("migrate");

    const { status, calls } = entrypoint(["migrat"]);

    expect(status).toBe(64);
    expect(calls).toEqual([]);
  });
});

describe.skipIf(!sh)("which connection each step uses", () => {
  /**
   * The runtime DATABASE_URL carries statement_timeout and lock_timeout
   * (set in the API Application, modelled in .env.example). A CREATE INDEX
   * or a backfill must not be cancelled halfway by the runtime ceiling, and
   * lock_timeout must not cut short the migrate advisory-lock wait — so the
   * schema steps run on MIGRATION_DATABASE_URL, and only the server keeps
   * the timed one.
   */
  const env = {
    DATABASE_URL: "postgresql://runtime",
    MIGRATION_DATABASE_URL: "postgresql://migration",
  };

  beforeEach(() => prismaCli("migrate"));

  it("migrates and seeds on the migration URL", () => {
    const { calls } = entrypoint(["migrate"], env);

    const schemaSteps = calls.filter((line) =>
      /^(prisma migrate deploy|seed |import-violation-codes )/.test(line),
    );

    expect(schemaSteps).toHaveLength(3);
    for (const line of schemaSteps) {
      expect(line).toContain("DATABASE_URL=postgresql://migration");
    }
  });

  it("serves on the runtime URL", () => {
    const { calls } = entrypoint([], env);

    expect(calls.find((line) => line.startsWith("server "))).toContain(
      "DATABASE_URL=postgresql://runtime",
    );
  });

  it("falls back to DATABASE_URL when no migration URL is set", () => {
    const { calls } = entrypoint(["migrate"], {
      DATABASE_URL: "postgresql://only",
    });

    expect(calls.find((line) => line.startsWith("prisma "))).toContain(
      "DATABASE_URL=postgresql://only",
    );
  });
});

describe("yarn start", () => {
  const scripts = JSON.parse(readFileSync(repoFile("package.json"), "utf8"))
    .scripts as Record<string, string>;

  it("is the image's boot script: no generate, no swallowed seeds", () => {
    // `prisma generate` at boot needs a writable node_modules and regenerates
    // the client the image already carries; the seeds ran through `exec`
    // callbacks that only logged their errors.
    expect(scripts.start).not.toMatch(/generate/);
    expect(scripts.start).not.toMatch(/seed/);
    expect(scripts.start).toContain("docker-entrypoint.sh");
  });

  it("has the release step as a script of its own", () => {
    expect(scripts["migrate:release"]).toMatch(
      /docker-entrypoint\.sh migrate\b/,
    );
  });

  // One way to find the script, not two: the release step is `start` plus
  // its mode, so a fix to where the script is looked up reaches both.
  it("finds the script the same way for the release step", () => {
    expect(scripts["migrate:release"].replace(/ migrate\b/g, "")).toBe(
      scripts.start,
    );
  });
});

/**
 * `yarn start` and `yarn migrate:release` where each of them can run.
 *
 * Both pointed at infra/scripts/docker-entrypoint.sh, which exists in the
 * repository but not in the images: the Dockerfile copies the script to
 * ./docker-entrypoint.sh (their CMD) and takes nothing else from infra/.
 * Inside a container — a debug shell, another orchestrator — both failed
 * with "can't open". The scripts now run whichever copy is there; the steps
 * themselves still live in that one file.
 */
describe.skipIf(!sh)(
  "the package scripts, in the repository and in the image",
  () => {
    const scripts = JSON.parse(readFileSync(repoFile("package.json"), "utf8"))
      .scripts as Record<string, string>;

    const layouts = {
      repository: "infra/scripts/docker-entrypoint.sh",
      image: "docker-entrypoint.sh",
    } as const;

    function runScript(
      name: "start" | "migrate:release",
      layout: keyof typeof layouts,
    ) {
      box.file(
        layouts[layout],
        readFileSync(repoFile("infra/scripts/docker-entrypoint.sh"), "utf8"),
      );

      // What yarn and npm do with a script on Linux: `sh -c`, in the package root.
      const result = spawnSync("sh", ["-c", scripts[name]], {
        cwd: box.root,
        env: {
          ...process.env,
          STUB_LOG: box.log,
          DATABASE_URL: "postgresql://runtime",
        },
        encoding: "utf8",
        timeout: 30_000,
      });

      const calls = readFileSync(box.log, "utf8").split("\n").filter(Boolean);
      const called = (what: string) =>
        calls.some((line) => line.startsWith(what));

      return { status: result.status, stderr: result.stderr ?? "", called };
    }

    it.each(Object.keys(layouts) as (keyof typeof layouts)[])(
      "`start` boots the server (%s)",
      (layout) => {
        const { status, stderr, called } = runScript("start", layout);

        expect(status, stderr).toBe(0);
        expect(called("server ")).toBe(true);
      },
    );

    it.each(Object.keys(layouts) as (keyof typeof layouts)[])(
      "`migrate:release` migrates and never serves (%s)",
      (layout) => {
        // The release image's layout: the CLI in migrate/.
        prismaCli("migrate");

        const { status, stderr, called } = runScript("migrate:release", layout);

        expect(status, stderr).toBe(0);
        expect(called("prisma migrate deploy")).toBe(true);
        expect(called("server ")).toBe(false);
      },
    );
  },
);
