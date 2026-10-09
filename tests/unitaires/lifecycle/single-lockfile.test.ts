import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * One lockfile: yarn.lock.
 *
 * The Dockerfile, ci.yml and deploy.yml install with
 * `yarn install --frozen-lockfile`, so yarn.lock is the tree that ships. A
 * package-lock.json sat next to it, left by an `npm install`, resolving an
 * older tree (socket.io 4.8.1, undici 6.28.0: versions with advisories that
 * yarn.lock no longer has). Everything that looks at the directory rather
 * than at the pipeline read that one instead: `npm ci`, `npm audit`, and
 * audit-ci's auto-detection (audit-ci.jsonc now names yarn for that reason).
 */
const ROOT = process.cwd();

const OTHER_LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "bun.lockb", "bun.lock"];

function isIgnored(path: string): boolean {
  try {
    // --no-index: the pattern decides, whatever is or is not tracked.
    execFileSync("git", ["check-ignore", "-q", "--no-index", path], { cwd: ROOT, stdio: "ignore" });
    return true;
  } catch (error) {
    if ((error as { status?: number }).status === 1) return false;
    throw error;
  }
}

describe("the lockfile", () => {
  it("is yarn.lock, alone on disk", () => {
    expect(existsSync(resolve(ROOT, "yarn.lock"))).toBe(true);

    // Fails on a machine where `npm install` left one behind: delete it.
    expect(OTHER_LOCKFILES.filter((name) => existsSync(resolve(ROOT, name)))).toEqual([]);
  });

  it("is yarn.lock, alone in the repository", () => {
    const tracked = execFileSync("git", ["ls-files", "--", "yarn.lock", ...OTHER_LOCKFILES], {
      cwd: ROOT,
      encoding: "utf8",
    })
      .split(/\r?\n/)
      .filter(Boolean);

    expect(tracked).toEqual(["yarn.lock"]);
  });

  it("keeps an npm lockfile out of the repository", () => {
    expect(isIgnored("package-lock.json")).toBe(true);
    expect(isIgnored("yarn.lock")).toBe(false);
  });

  it("is the one every install in the pipeline reads", () => {
    for (const path of ["Dockerfile", ".github/workflows/ci.yml", ".github/workflows/deploy.yml"]) {
      const text = readFileSync(resolve(ROOT, path), "utf8");

      expect(text, path).toMatch(/yarn install --frozen-lockfile/);
      expect(text, path).not.toMatch(/\bnpm (?:ci|install|i)\b/);
    }
  });
});
