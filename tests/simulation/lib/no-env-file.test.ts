import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ENV_FILE_GUARD, prismaArgs, tsxArgs } from "./guarded-node";
import { API_ROOT } from "./sim-config";

/**
 * The simulation's processes run from the API folder, where the developer's
 * real `.env` lives. These tests use a folder of their own with a fake one:
 * the real file is never opened, here or anywhere in the simulation.
 */

// What src/env/index.ts and prisma.config.ts do at boot.
const PROBE = `
const api = ${JSON.stringify(API_ROOT)};
const dotenv = require(require.resolve("dotenv", { paths: [api] }));
const dotenvExpand = require(require.resolve("dotenv-expand", { paths: [api] }));
dotenvExpand.expand(dotenv.config());
console.log(JSON.stringify({
  empty: process.env.SIM_PROBE_EMPTY ?? null,
  added: process.env.SIM_PROBE_ADDED ?? null,
}));
`;

let folder: string;

/** NODE_OPTIONS minus any `--require` of the guard. */
function withoutGuard(options: string | undefined): string {
  return (options ?? "")
    .replace(/--require[= ]+\S*no-env-file\.cjs/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function run(args: string[]): {
  stdout: string;
  stderr: string;
  status: number | null;
} {
  const env: NodeJS.ProcessEnv = { ...process.env, SIM_PROBE_EMPTY: "" };

  delete env.SIM_PROBE_ADDED;
  // Each case says whether the guard is in (its args): one inherited from
  // the runner's own NODE_OPTIONS would preload it into the unguarded probe.
  env.NODE_OPTIONS = withoutGuard(env.NODE_OPTIONS);

  const result = spawnSync(process.execPath, args, {
    cwd: folder,
    env,
    encoding: "utf8",
    timeout: 60_000,
  });

  return {
    stdout: result.stdout.trim(),
    stderr: result.stderr,
    status: result.status,
  };
}

beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), "sim-no-env-file-"));

  writeFileSync(
    join(folder, ".env"),
    "SIM_PROBE_EMPTY=vazou\nSIM_PROBE_ADDED=vazou\n",
  );
  writeFileSync(join(folder, ".env.example"), "SIM_PROBE_EMPTY=\n");
  writeFileSync(join(folder, "probe.cjs"), PROBE);
  writeFileSync(join(folder, "probe.ts"), PROBE);
});

afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

describe("the .env guard of the simulation's processes", () => {
  it("exists because dotenv-expand fills an EMPTY variable from .env", () => {
    // The simulated env leaves a key empty to switch an integration off;
    // dotenv keeps it empty, dotenv-expand copies the file's value over it.
    expect(JSON.parse(run(["probe.cjs"]).stdout)).toEqual({
      empty: "vazou",
      added: "vazou",
    });
  });

  it("makes every .env file absent to the process it is preloaded in", () => {
    const { stdout, stderr } = run(["--require", ENV_FILE_GUARD, "probe.cjs"]);

    expect(JSON.parse(stdout)).toEqual({ empty: "", added: null });
    expect(stderr).toMatch(/\.env ignorado/);
  });

  it("reaches the server process tsx starts (the replicas)", () => {
    const { stdout } = run(tsxArgs("probe.ts"));

    expect(JSON.parse(stdout)).toEqual({ empty: "", added: null });
  });

  it("goes before the Prisma CLI, which loads prisma.config.ts", () => {
    const args = prismaArgs("migrate", "deploy");

    expect(args.slice(0, 2)).toEqual(["--require", ENV_FILE_GUARD]);
    expect(args.slice(-2)).toEqual(["migrate", "deploy"]);
  });

  it("hides every .env file from stat too, as a missing file", () => {
    const { stdout } = run([
      "--require",
      ENV_FILE_GUARD,
      "-e",
      `const fs = require("node:fs");
const code = (call) => { try { call(); return null; } catch (error) { return error.code; } };
fs.stat(".env", (error) => {
  fs.promises.stat(".env.local").catch((reason) => reason.code).then((promised) => {
    console.log(JSON.stringify({
      quiet: fs.statSync(".env", { throwIfNoEntry: false }) ?? null,
      stat: code(() => fs.statSync(".env")),
      callback: error?.code ?? null,
      promised,
      example: fs.statSync(".env.example").isFile(),
    }));
  });
});`,
    ]);

    expect(JSON.parse(stdout)).toEqual({
      quiet: null,
      stat: "ENOENT",
      callback: "ENOENT",
      promised: "ENOENT",
      example: true,
    });
  });

  it("hides every .env file from a folder listing too, as it does from stat", () => {
    // A scan lists a folder and stats each entry (agent-guides.test.ts): a
    // listed .env then failed the stat, only where a real .env exists.
    const { stdout, stderr, status } = run([
      "--require",
      ENV_FILE_GUARD,
      "-e",
      `const fs = require("node:fs");
const path = require("node:path");
fs.mkdirSync("listed/sub", { recursive: true });
for (const file of [".env", ".env.local", ".ENV.test", ".env.example", "keep.txt", "sub/.env.production", "sub/kept.md"]) {
  fs.writeFileSync(path.join("listed", file), "X=1\\n");
}
const names = (entries) => entries.map((entry) => typeof entry === "object" && !Buffer.isBuffer(entry) ? entry.name : String(entry).replace(/\\\\/g, "/")).sort();
const scan = (dir) => fs.readdirSync(dir).flatMap((name) => {
  const file = path.join(dir, name);
  return fs.statSync(file).isDirectory() ? scan(file) : [file.replace(/\\\\/g, "/")];
}).sort();
fs.readdir("listed", (error, plain) => {
  fs.readdir("listed", { withFileTypes: true }, (typedError, typed) => {
    fs.promises.readdir("listed", { withFileTypes: true }).then((promised) => {
      console.log(JSON.stringify({
        sync: names(fs.readdirSync("listed")),
        types: names(fs.readdirSync("listed", { withFileTypes: true })),
        buffers: names(fs.readdirSync("listed", "buffer")),
        recursive: names(fs.readdirSync("listed", { recursive: true })),
        recursiveTypes: names(fs.readdirSync("listed", { recursive: true, withFileTypes: true })),
        callback: error ?? names(plain),
        callbackTypes: typedError ?? names(typed),
        promised: names(promised),
        scan: scan("listed"),
      }));
    });
  });
});`,
    ]);

    expect(stderr).not.toMatch(/ENOENT/);
    expect(status).toBe(0);

    const top = [".env.example", "keep.txt", "sub"];

    expect(JSON.parse(stdout)).toEqual({
      sync: top,
      types: top,
      buffers: top,
      recursive: [...top, "sub/kept.md"],
      recursiveTypes: [".env.example", "keep.txt", "kept.md", "sub"],
      callback: top,
      callbackTypes: top,
      promised: top,
      scan: ["listed/.env.example", "listed/keep.txt", "listed/sub/kept.md"],
    });
  });

  it("hides them from the listings an ES module imports as well", () => {
    const { stdout } = run([
      "--require",
      ENV_FILE_GUARD,
      "--input-type=module",
      "-e",
      `import { readdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
const sync = readdirSync(".").filter((name) => name.startsWith(".env"));
const promised = (await readdir(".")).filter((name) => name.startsWith(".env"));
console.log(JSON.stringify({ sync, promised }));`,
    ]);

    expect(JSON.parse(stdout)).toEqual({
      sync: [".env.example"],
      promised: [".env.example"],
    });
  });

  it("keeps lstat real, and lists the real folder to a removal, so a folder holding a .env can still be removed", () => {
    // Node's recursive removal lists each folder and then removes every
    // entry it listed: a listing without the .env would leave it behind
    // (ENOTEMPTY). And the removal's own callback, or the code after its
    // promise, is back outside it: the guard's folder still has its .env.
    const { stdout, stderr, status } = run([
      "--require",
      ENV_FILE_GUARD,
      "-e",
      `const fs = require("node:fs");
const doom = (dir) => {
  fs.mkdirSync(dir + "/inner", { recursive: true });
  fs.writeFileSync(dir + "/.env", "X=1\\n");
  fs.writeFileSync(dir + "/inner/.env.local", "X=1\\n");
  return dir;
};
const gone = (dir) => !fs.readdirSync(".").includes(dir);
const envListed = () => fs.readdirSync(".").includes(".env");
const result = {};
fs.rmSync(doom("doomed-sync"), { recursive: true, force: true });
result.rmSync = gone("doomed-sync");
fs.rmdirSync(doom("doomed-rmdir"), { recursive: true });
result.rmdirSync = gone("doomed-rmdir");
fs.rm(doom("doomed-callback"), { recursive: true, force: true }, (error) => {
  result.rm = error?.code ?? gone("doomed-callback");
  result.envListedInCallback = envListed();
  fs.promises.rm(doom("doomed-promise"), { recursive: true, force: true }).then(() => {
    result.promisesRm = gone("doomed-promise");
    result.envListedAfterPromise = envListed();
    console.log(JSON.stringify(result));
  }, (reason) => console.log(JSON.stringify({ ...result, promisesRm: reason.code })));
});`,
    ]);

    expect(stderr).not.toMatch(/ENOTEMPTY|ENOENT/);
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      rmSync: true,
      rmdirSync: true,
      rm: true,
      envListedInCallback: false,
      promisesRm: true,
      envListedAfterPromise: false,
    });
  });

  it("lets a loader that stats before reading skip the file (vite, under vitest)", () => {
    // Vite's loadEnv checks each .env with statSync({ throwIfNoEntry: false })
    // and then reads it: with stat unguarded, the read threw out of vitest's
    // boot instead of the file being skipped.
    const { stdout, stderr, status } = run([
      "--require",
      ENV_FILE_GUARD,
      "-e",
      `const vite = require(require.resolve("vite", { paths: [${JSON.stringify(API_ROOT)}] }));
console.log(JSON.stringify(vite.loadEnv("test", process.cwd(), "SIM_PROBE_")));`,
    ]);

    expect(stderr).not.toMatch(/ENOENT/);
    expect(status).toBe(0);
    // The variable's own (empty) value, never the file's.
    expect(JSON.parse(stdout)).toEqual({ SIM_PROBE_EMPTY: "" });
  });

  it("still lets .env.example be read, and is safe to load twice", () => {
    const { stdout } = run([
      "--require",
      ENV_FILE_GUARD,
      "--require",
      ENV_FILE_GUARD,
      "-e",
      `console.log(JSON.stringify(require("node:fs").readFileSync(".env.example", "utf8")))`,
    ]);

    expect(JSON.parse(stdout)).toBe("SIM_PROBE_EMPTY=\n");
  });
});
