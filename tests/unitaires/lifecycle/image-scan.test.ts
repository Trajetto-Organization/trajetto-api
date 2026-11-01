import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * What the image scan (Trivy, deploy.yml) is allowed to find.
 *
 * Enforced (IMAGE_SCAN_ENFORCE=true) on 27/10/2026, the first run failed on
 * `tar` (CVE-2026-59873, CRITICAL) in two places: the npm the Node image
 * ships (6.2.1 and 7.4.3 in its bundled tree) and the API's own
 * node_modules, through bcrypt 5 → @mapbox/node-pre-gyp → tar 6.2.1. The
 * runtime starts with ./docker-entrypoint.sh and node, and the migrations
 * run the same script (`release`), so no package manager is needed there;
 * bcrypt 6 ships prebuilt binaries (musl included) with no node-pre-gyp.
 *
 * The next run stopped on the AI image (infra/ai-ocr): certifi 2026.7.22
 * (GHSA-6q48-6c7w-9gw2, compromised emSign roots) and Pillow 12.3.0 (four
 * CRITICAL decoder CVEs, fixed in 13.0.0) — and that service decodes the
 * photos users upload.
 */
const root = process.cwd();
const read = (file: string) =>
  readFileSync(resolve(root, file), "utf8").replace(/\r\n/g, "\n");

const dockerfile = read("Dockerfile");
const runner = dockerfile.slice(dockerfile.indexOf("FROM base AS runner"));

/** The instructions between two markers, comments dropped. */
const code = (from: string, to?: string) =>
  dockerfile
    .slice(
      dockerfile.indexOf(from),
      to === undefined ? undefined : dockerfile.indexOf(to),
    )
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

describe("the image the scanner reads", () => {
  // The runner used to start from the Node image and `rm -rf` its npm,
  // corepack and yarn: hidden from the scanner, still in every pull (layers
  // are additive). Its base is now Alpine plus the node binary alone.
  it("ships no package manager in the runtime stage", () => {
    const binary = code("FROM node AS node-binary", "FROM alpine:");
    const base = code("FROM alpine:", "FROM node AS deps");
    const runtime = `${base}\n${code("FROM base AS runner")}`;

    expect(base).toMatch(/^FROM alpine:[\d.]+@sha256:[0-9a-f]{64} AS base$/m);
    expect(runner).toMatch(/^FROM base AS runner$/m);
    expect(base.match(/^COPY .*$/gm)).toEqual([
      "COPY --link --from=node-binary /out/ /",
    ]);
    // The one file that stage reads from the Node image (copied, and the
    // reference for its directories' mtime); the rest is under /out.
    expect(binary.match(/(?<![\w/])\/usr\/[\w/]+/g)).toEqual([
      "/usr/local/bin/node",
      "/usr/local/bin/node",
    ]);

    for (const path of [
      "/usr/local/lib/node_modules",
      "/usr/local/bin/npm",
      "corepack",
      "/opt/yarn",
    ]) {
      expect(runtime, path).not.toContain(path);
    }

    // Nothing left for a package manager to use.
    expect(runner).not.toMatch(/YARN_CACHE_FOLDER|YARN_GLOBAL_FOLDER/);
  });

  it("takes the fixed OpenSSL from Alpine at build time", () => {
    expect(code("FROM alpine:", "FROM node AS deps")).toMatch(
      /apk upgrade --no-cache[^\n]*libcrypto3[^\n]*libssl3/,
    );
  });

  it("starts and migrates without a package manager", () => {
    expect(runner).toMatch(/^CMD \["\.\/docker-entrypoint\.sh"\]$/m);
    // The release image (the Application trajetto-api-migrate) runs the
    // same script, in its `release` mode.
    expect(code("FROM runner AS migrate")).toMatch(
      /^CMD \["\.\/docker-entrypoint\.sh", "release"\]$/m,
    );
  });

  it("resolves no tar older than the fix, and no node-pre-gyp", () => {
    const lock = read("yarn.lock");
    const versions = [
      ...lock.matchAll(/^"?tar@[^\n]*:\n {2}version "([\d.]+)"/gm),
    ].map((match) => match[1]);

    expect(versions.length).toBeGreaterThan(0);
    for (const version of versions) {
      const [major, minor, patch] = version.split(".").map(Number);
      const fixed =
        major > 7 ||
        (major === 7 && (minor > 5 || (minor === 5 && patch >= 19)));

      expect(fixed, `tar ${version}`).toBe(true);
    }

    expect(lock).not.toMatch(/^"?@mapbox\/node-pre-gyp@/m);
  });

  it("pins the AI image's Python packages at or above their fixes", () => {
    // Every runtime requirements file (one per image layer since 28/10/2026),
    // so a pin cannot dodge this by moving to another layer's file.
    const runtime = readdirSync(resolve(root, "infra/ai-ocr"))
      .filter((name) => /^requirements(?:-[\w-]+)?\.txt$/.test(name))
      .filter((name) => name !== "requirements-test.txt");

    expect(runtime).toContain("requirements.txt");

    const pins = Object.fromEntries(
      runtime.flatMap((name) =>
        [
          ...read(`infra/ai-ocr/${name}`).matchAll(
            /^([A-Za-z0-9_.-]+)==([\d.]+) --hash=sha256:[0-9a-f]{64}$/gm,
          ),
        ].map(([, pkg, version]) => [pkg.toLowerCase(), version]),
      ),
    );
    const atLeast = (version: string, floor: string) => {
      const a = version.split(".").map(Number);
      const b = floor.split(".").map(Number);
      for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
        if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
      }
      return true;
    };

    for (const [name, floor] of [
      ["pillow", "13.0.0"],
      ["certifi", "2026.10.18"],
    ]) {
      expect(pins[name], name).toBeDefined();
      expect(atLeast(pins[name], floor), `${name} ${pins[name]}`).toBe(true);
    }
  });
});
