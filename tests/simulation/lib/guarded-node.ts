import { resolve } from "node:path";

import { API_ROOT } from "./sim-config";

/**
 * How the simulation starts a process that runs API code (a replica, the
 * Prisma CLI): plain `node` with the `.env` guard preloaded (no-env-file.cjs),
 * so the developer's `.env` in the API folder is never read by it.
 *
 * node + each tool's own entry, never `npx`: on Windows `npx` is a .cmd, and
 * spawning one without a shell fails with EINVAL since Node 20.
 */

/** Preloaded with `--require`; see the file for why. */
const ENV_FILE_GUARD = resolve(__dirname, "no-env-file.cjs");

/**
 * `node <these> ` runs `entry` with tsx. tsx starts the program in a child
 * process of its own, and only what comes after its CLI on the command line
 * reaches that child: a `--require` before the CLI would guard tsx alone.
 */
function tsxArgs(entry: string, ...rest: string[]): string[] {
  return [
    resolve(API_ROOT, "node_modules", "tsx", "dist", "cli.mjs"),
    "--require",
    ENV_FILE_GUARD,
    entry,
    ...rest,
  ];
}

/** `node <these>` runs the Prisma CLI, which loads prisma.config.ts in-process. */
function prismaArgs(...rest: string[]): string[] {
  return [
    "--require",
    ENV_FILE_GUARD,
    resolve(API_ROOT, "node_modules", "prisma", "build", "index.js"),
    ...rest,
  ];
}

export { ENV_FILE_GUARD, prismaArgs, tsxArgs };
