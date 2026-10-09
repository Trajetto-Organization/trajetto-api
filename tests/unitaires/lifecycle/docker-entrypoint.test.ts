import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  hasShell,
  repoFile,
  run,
  sandbox,
  type Sandbox,
} from "./support/shell-harness";

/**
 * The image's boot script, run for real against stubbed build outputs.
 *
 * Every replica used to migrate and seed on boot, and the seeds' failures
 * were swallowed by `|| echo`. A broken seed (no MASTER_USER_EMAIL, a schema
 * error) went unnoticed while the system came up without its master user or
 * its violation codes; and a migration that failed or ran long left
 * `_prisma_migrations` in P3009, refusing the boot of EVERY image version
 * until someone ran `migrate resolve` by hand.
 *
 * `migrate` mode is the one-shot release step: it migrates and seeds once,
 * fails loudly, and never starts the server.
 */
const sh = hasShell("sh");

let box: Sandbox;

/** A build/*.js stand-in that records itself and exits as told. */
const nodeStub = (name: string, exitVar: string) => `
require("node:fs").appendFileSync(
  process.env.STUB_LOG,
  "${name} DATABASE_URL=" + (process.env.DATABASE_URL ?? "") + "\\n",
);
process.exit(Number(process.env.${exitVar} ?? 0));
`;

beforeEach(() => {
  box = sandbox();

  box.file("build/wait-for-postgres.js", nodeStub("wait-for-postgres", "STUB_WAIT_EXIT"));
  box.file("build/seed.js", nodeStub("seed", "STUB_SEED_EXIT"));
  box.file(
    "build/import-violation-codes.js",
    nodeStub("import-violation-codes", "STUB_IMPORT_EXIT"),
  );
  box.file("build/server.js", nodeStub("server", "STUB_SERVER_EXIT"));

  box.file(
    "node_modules/.bin/prisma",
    `#!/bin/sh\nprintf '%s\\n' "prisma $* DATABASE_URL=$DATABASE_URL" >> "$STUB_LOG"\nexit "\${STUB_PRISMA_EXIT:-0}"\n`,
  );
});

afterEach(() => box.dispose());

function entrypoint(args: string[], env: Record<string, string> = {}) {
  const result = run("sh", repoFile("infra/scripts/docker-entrypoint.sh"), args, {
    cwd: box.root,
    env: {
      STUB_LOG: box.log,
      DATABASE_URL: "postgresql://runtime",
      ...env,
    },
  });

  const calls = readFileSync(box.log, "utf8").split("\n").filter(Boolean);
  const called = (what: string) => calls.some((line) => line.startsWith(what));

  return { ...result, calls, called };
}

describe.skipIf(!sh)("the release step (`migrate` mode)", () => {
  it("migrates and seeds once, and never starts the server", () => {
    const { status, calls, called } = entrypoint(["migrate"]);

    expect(status, calls.join("\n")).toBe(0);
    expect(calls.some((line) => line.startsWith("prisma migrate deploy"))).toBe(true);
    expect(called("seed ")).toBe(true);
    expect(called("import-violation-codes ")).toBe(true);
    expect(called("server ")).toBe(false);
  });

  it("fails when a seed fails, instead of swallowing it", () => {
    const { status, called } = entrypoint(["migrate"], { STUB_SEED_EXIT: "1" });

    expect(status).not.toBe(0);
    expect(called("prisma migrate deploy")).toBe(true);
    expect(called("server ")).toBe(false);
  });

  it("fails when the violation-code import fails", () => {
    const { status, called } = entrypoint(["migrate"], { STUB_IMPORT_EXIT: "1" });

    expect(status).not.toBe(0);
    expect(called("server ")).toBe(false);
  });

  it("stops at a failed migration, before any seed", () => {
    const { status, called } = entrypoint(["migrate"], { STUB_PRISMA_EXIT: "1" });

    expect(status).not.toBe(0);
    expect(called("seed ")).toBe(false);
  });

  it("does nothing at all when the database is refused", () => {
    const { status, calls } = entrypoint(["migrate"], { STUB_WAIT_EXIT: "1" });

    expect(status).not.toBe(0);
    expect(calls).toEqual([expect.stringMatching(/^wait-for-postgres /)]);
  });
});

describe.skipIf(!sh)("the boot (`serve`, the default)", () => {
  it("serves without touching the schema once boot migrations are off", () => {
    const { status, called } = entrypoint([], { RUN_MIGRATIONS_ON_BOOT: "false" });

    expect(status).toBe(0);
    expect(called("prisma ")).toBe(false);
    expect(called("seed ")).toBe(false);
    expect(called("server ")).toBe(true);
  });

  it("still migrates on boot by default, as before", () => {
    const { status, called } = entrypoint([]);

    expect(status).toBe(0);
    expect(called("prisma migrate deploy")).toBe(true);
    expect(called("server ")).toBe(true);
  });

  it("keeps booting on a seed failure, but reports it as an error", () => {
    const { status, stderr, called } = entrypoint([], { STUB_SEED_EXIT: "1" });

    expect(status).toBe(0);
    expect(called("server ")).toBe(true);
    expect(stderr).toMatch(/ERRO/);
  });

  it("never starts the server over a failed migration", () => {
    const { status, called } = entrypoint([], { STUB_PRISMA_EXIT: "1" });

    expect(status).not.toBe(0);
    expect(called("server ")).toBe(false);
  });

  it("refuses an unknown mode rather than guessing", () => {
    const { status, called } = entrypoint(["migrat"]);

    expect(status).not.toBe(0);
    expect(called("prisma ")).toBe(false);
    expect(called("server ")).toBe(false);
  });
});

describe.skipIf(!sh)("which connection each step uses", () => {
  /**
   * The runtime DATABASE_URL carries statement_timeout and lock_timeout
   * (compose.production.yaml). A CREATE INDEX or a backfill must not be
   * cancelled halfway by the runtime ceiling, and lock_timeout must not cut
   * short the migrate advisory-lock wait during a start-first rollout — so the
   * schema steps run on MIGRATION_DATABASE_URL, and only the server keeps the
   * timed one.
   */
  const env = {
    DATABASE_URL: "postgresql://runtime",
    MIGRATION_DATABASE_URL: "postgresql://migration",
  };

  it.each([[["migrate"]], [[]]])("migrates and seeds on the migration URL (%j)", (args) => {
    const { calls } = entrypoint(args, env);

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
    const { calls } = entrypoint(["migrate"], { DATABASE_URL: "postgresql://only" });

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
    expect(scripts["migrate:release"]).toMatch(/docker-entrypoint\.sh migrate\b/);
  });

  // One way to find the script, not two: the release step is `start` plus
  // its mode, so a fix to where the script is looked up reaches both.
  it("finds the script the same way for the release step", () => {
    expect(scripts["migrate:release"].replace(/ migrate\b/g, "")).toBe(scripts.start);
  });
});

/**
 * `yarn start` and `yarn migrate:release` where each of them can run.
 *
 * Both pointed at infra/scripts/docker-entrypoint.sh, which exists in the
 * repository but not in the image: the Dockerfile copies the script to
 * ./docker-entrypoint.sh (its CMD) and the runner stage takes nothing else
 * from infra/. Inside the container — a debug shell, a one-off
 * `docker run … yarn migrate:release`, another orchestrator — both failed
 * with "can't open". The scripts now run whichever copy is there; the steps
 * themselves still live in that one file.
 */
describe.skipIf(!sh)("the package scripts, in the repository and in the image", () => {
  const scripts = JSON.parse(readFileSync(repoFile("package.json"), "utf8"))
    .scripts as Record<string, string>;

  const layouts = {
    repository: "infra/scripts/docker-entrypoint.sh",
    image: "docker-entrypoint.sh",
  } as const;

  function runScript(name: "start" | "migrate:release", layout: keyof typeof layouts) {
    box.file(layouts[layout], readFileSync(repoFile("infra/scripts/docker-entrypoint.sh"), "utf8"));

    // What yarn and npm do with a script on Linux: `sh -c`, in the package root.
    const result = spawnSync("sh", ["-c", scripts[name]], {
      cwd: box.root,
      env: { ...process.env, STUB_LOG: box.log, DATABASE_URL: "postgresql://runtime" },
      encoding: "utf8",
      timeout: 30_000,
    });

    const calls = readFileSync(box.log, "utf8").split("\n").filter(Boolean);
    const called = (what: string) => calls.some((line) => line.startsWith(what));

    return { status: result.status, stderr: result.stderr ?? "", called };
  }

  it.each(Object.keys(layouts) as (keyof typeof layouts)[])("`start` boots the server (%s)", (layout) => {
    const { status, stderr, called } = runScript("start", layout);

    expect(status, stderr).toBe(0);
    expect(called("server ")).toBe(true);
  });

  it.each(Object.keys(layouts) as (keyof typeof layouts)[])(
    "`migrate:release` migrates and never serves (%s)",
    (layout) => {
      const { status, stderr, called } = runScript("migrate:release", layout);

      expect(status, stderr).toBe(0);
      expect(called("prisma migrate deploy")).toBe(true);
      expect(called("server ")).toBe(false);
    },
  );
});
