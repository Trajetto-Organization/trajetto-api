import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MESSAGE_VERSIONS } from "@/shared/socket/messages";

import { readWorkflow, stepOf, jobOf } from "./support/workflow-text";

/**
 * What the realtime runs, as the deploy reads it (plano-escala F3-31c,
 * decision D7).
 *
 * `trajetto-realtime` holds every socket, and its deploy drops them all. It
 * is deployed only when what it runs changed: the image carries the hash of
 * its import closure and build inputs (`trajetto.realtime-source`) and the
 * contract epoch (`trajetto.contract-epoch`: contract migrations plus the
 * versions of the messages between processes), computed by
 * .github/scripts/realtime-closure.mjs, run for real here: on this
 * repository, and on a small one whose files the cases change.
 */
const SCRIPT = resolve(
  process.cwd(),
  ".github",
  "scripts",
  "realtime-closure.mjs",
);

function closure(command: string, root?: string) {
  const result = spawnSync(process.execPath, [SCRIPT, command], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...(root ? { REALTIME_CLOSURE_ROOT: root } : {}),
    },
    encoding: "utf8",
  });

  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr,
  };
}

describe("this repository's realtime closure", () => {
  const files = () => closure("--list").stdout.split("\n");

  it("is the list committed in .github/realtime-closure.txt", () => {
    const check = closure("--check");

    expect(check.status, check.stderr).toBe(0);
  });

  it("starts at the sockets and the boot, and reaches what they import", () => {
    const list = files();

    for (const file of [
      "src/websocket.ts",
      "src/server.ts",
      "src/http.ts",
      "src/routes/health-routes.ts",
      "src/shared/socket/messages.ts",
      "src/shared/socket/presence.ts",
      "src/shared/socket/emitter.ts",
    ]) {
      expect(list, file).toContain(file);
    }
  });

  it("leaves out the routes the realtime never serves, the workers and the import queue", () => {
    const list = files();

    for (const file of [
      "src/routes/routes.ts",
      "src/routes/fuel-routes.ts",
      "src/workers/index.ts",
      "src/modules/import/services/import-queue.ts",
    ]) {
      expect(list, file).not.toContain(file);
    }
  });

  it("reads the message versions the code declares", () => {
    const epoch = Number(closure("--epoch").stdout);
    const versions = Object.values(MESSAGE_VERSIONS).reduce(
      (total: number, version: number) => total + version,
      0,
    );

    // The contract migrations come on top of the versions.
    expect(epoch).toBeGreaterThanOrEqual(versions);
  });
});

describe("the labels, on a small repository", () => {
  let root: string;

  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };

  const source = () => closure("--source", root).stdout;
  const epoch = () => Number(closure("--epoch", root).stdout);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "realtime-closure-"));

    write(
      "src/websocket.ts",
      [
        'import { a } from "./shared/a";',
        'import type { T } from "./shared/types";',
        'import { messages } from "@/shared/socket/messages";',
        "export const ws = [a, messages];",
      ].join("\n"),
    );
    write(
      "src/server.ts",
      [
        'import "reflect-metadata";',
        'import { app } from "./http";',
        'import { initializeWorkers } from "./workers";',
        "export { app, initializeWorkers };",
      ].join("\n"),
    );
    write(
      "src/http.ts",
      [
        'import { routes } from "./routes/routes";',
        'export * from "./shared/b";',
        "export const app = routes;",
      ].join("\n"),
    );
    write(
      "src/routes/health-routes.ts",
      'export const health = () => import("../shared/c");\n',
    );
    write(
      "src/routes/routes.ts",
      'import { fuel } from "./fuel-routes";\nexport const routes = [fuel];\n',
    );
    write("src/routes/fuel-routes.ts", "export const fuel = 1;\n");
    write("src/workers/index.ts", 'import "../shared/d";\n');
    write("src/shared/a.ts", "export const a = 1;\n");
    write("src/shared/b.ts", "export const b = 1;\n");
    write("src/shared/c.ts", "export const c = 1;\n");
    write("src/shared/d.ts", "export const d = 1;\n");
    write("src/shared/types.ts", "export type T = string;\n");
    write(
      "src/shared/socket/messages.ts",
      [
        "const MESSAGE_VERSIONS = {",
        '  "adopt-session-version": 1,',
        "  wake: 1,",
        "} as const;",
        "export const messages = MESSAGE_VERSIONS;",
      ].join("\n"),
    );
    write(
      "infra/scripts/wait-for-postgres.ts",
      'import { refusal } from "./schema-guard";\nexport const wait = refusal;\n',
    );
    write("infra/scripts/schema-guard.ts", "export const refusal = 1;\n");
    write(
      "infra/scripts/docker-entrypoint.sh",
      "#!/bin/sh\nnode build/wait-for-postgres.js\nexec node build/server.js\n",
    );
    write(
      "Dockerfile",
      "FROM node:22.21.1-alpine3.23@sha256:aaa AS node\nFROM alpine:3.23.7@sha256:bbb AS base\n",
    );
    write(".dockerignore", "node_modules\n");
    write("package.json", '{ "dependencies": {} }\n');
    write("yarn.lock", "# lock\n");
    write("prisma/schema.prisma", "model User {\n  id String @id\n}\n");
    write(
      "prisma/migrations/1_expand/migration.sql",
      'ALTER TABLE "user" ADD COLUMN "x" TEXT;\n',
    );
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("follows imports, re-exports and literal dynamic imports, not types nor boundaries", () => {
    const list = closure("--list", root).stdout.split("\n");

    expect(list).toEqual(
      [
        "infra/scripts/schema-guard.ts",
        "infra/scripts/wait-for-postgres.ts",
        "src/http.ts",
        "src/routes/health-routes.ts",
        "src/server.ts",
        "src/shared/a.ts",
        "src/shared/b.ts",
        "src/shared/c.ts",
        "src/shared/socket/messages.ts",
        "src/websocket.ts",
      ].sort(),
    );
  });

  it("does not move when a route outside the closure changes: the realtime is held", () => {
    const before = source();

    write("src/routes/fuel-routes.ts", "export const fuel = 2;\n");
    write("src/shared/d.ts", "export const d = 2;\n");
    write("src/shared/types.ts", "export type T = number;\n");

    expect(source()).toBe(before);
  });

  it.each([
    ["src/websocket.ts", "export const ws = 2;\n"],
    ["src/shared/a.ts", "export const a = 2;\n"],
    ["src/shared/c.ts", "export const c = 2;\n"],
    ["yarn.lock", "# lock 2\n"],
    ["prisma/schema.prisma", "model User {\n  id String @id\n  x String?\n}\n"],
    // The image the socket server runs in: a Node or Alpine digest bump (a
    // CVE fix) must not leave it on the old runtime for up to 7 days.
    [
      "Dockerfile",
      "FROM node:22.21.2-alpine3.23@sha256:ccc AS node\nFROM alpine:3.23.7@sha256:bbb AS base\n",
    ],
    [".dockerignore", "node_modules\ncoverage\n"],
    [
      "infra/scripts/docker-entrypoint.sh",
      "#!/bin/sh\nnode build/wait-for-postgres.js --require-migrations x\nexec node build/server.js\n",
    ],
    // The boot's wait for Postgres, run before server.js.
    ["infra/scripts/schema-guard.ts", "export const refusal = 2;\n"],
  ])("moves when %s changes: the realtime is deployed", (path, text) => {
    const before = source();

    write(path, text);

    expect(source()).not.toBe(before);
  });

  it("hashes a CRLF checkout as the repository's LF", () => {
    const before = source();

    write(
      "src/shared/a.ts",
      readFileSync(join(root, "src/shared/a.ts"), "utf8").replace(
        /\n/g,
        "\r\n",
      ),
    );

    expect(source()).toBe(before);
  });

  it("grows the epoch with a contract migration, not with an expand one", () => {
    expect(epoch()).toBe(2);

    write(
      "prisma/migrations/2_expand/migration.sql",
      'CREATE TABLE "y" ("id" TEXT);\n',
    );
    expect(epoch()).toBe(2);

    write(
      "prisma/migrations/3_contract/migration.sql",
      '-- contract-phase: 2026.11 stopped reading it\nALTER TABLE "user" DROP COLUMN "x";\n',
    );
    expect(epoch()).toBe(3);
  });

  it("grows the epoch with a message's new version", () => {
    write(
      "src/shared/socket/messages.ts",
      [
        "const MESSAGE_VERSIONS = {",
        '  "adopt-session-version": 2,',
        "  wake: 1,",
        "} as const;",
        "export const messages = MESSAGE_VERSIONS;",
      ].join("\n"),
    );

    expect(epoch()).toBe(3);
  });
});

describe("the image and the build", () => {
  const dockerfile = readFileSync(
    resolve(process.cwd(), "Dockerfile"),
    "utf8",
  ).replace(/\r\n/g, "\n");

  it("labels the runner stage after its last RUN, from build args", () => {
    const runner = dockerfile.slice(
      dockerfile.indexOf("AS runner"),
      dockerfile.indexOf("FROM runner AS migrate"),
    );
    const lastRun = runner.lastIndexOf("\nRUN ");

    for (const line of [
      'ARG REALTIME_SOURCE=""',
      'ARG CONTRACT_EPOCH=""',
      'LABEL trajetto.realtime-source="${REALTIME_SOURCE}"',
      'trajetto.contract-epoch="${CONTRACT_EPOCH}"',
    ]) {
      expect(runner.indexOf(line), line).toBeGreaterThan(lastRun);
    }
  });

  // The process writes them in its process_heartbeat row, so the fleet's
  // alert (mixed-versions) can tell the realtime the deploy held on its
  // build from a role left on the old one.
  it("gives the process the same two values, after the last RUN", () => {
    const runner = dockerfile.slice(
      dockerfile.indexOf("AS runner"),
      dockerfile.indexOf("FROM runner AS migrate"),
    );
    const lastRun = runner.lastIndexOf("\nRUN ");

    for (const line of [
      "ENV APP_REALTIME_SOURCE=${REALTIME_SOURCE}",
      "APP_CONTRACT_EPOCH=${CONTRACT_EPOCH}",
    ]) {
      expect(runner.indexOf(line), line).toBeGreaterThan(lastRun);
    }
  });

  it("passes the labels to the smoke build and the push of the API image alike", () => {
    const build = jobOf(readWorkflow("staging.yml"), "build");
    const compute = stepOf(build, "Compute the realtime labels").text;

    expect(compute).toContain(
      "node .github/scripts/realtime-closure.mjs --source",
    );
    expect(compute).toContain(
      "node .github/scripts/realtime-closure.mjs --epoch",
    );

    for (const step of [
      "Build the API image for the smoke test",
      "Build and push the API image",
    ]) {
      const text = stepOf(build, step).text;

      expect(text, step).toContain(
        "REALTIME_SOURCE=${{ steps.realtime.outputs.source }}",
      );
      expect(text, step).toContain(
        "CONTRACT_EPOCH=${{ steps.realtime.outputs.epoch }}",
      );
    }
  });
});
