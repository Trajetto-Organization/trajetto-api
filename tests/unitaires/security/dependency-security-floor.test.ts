import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The versions below which a production dependency is known to be
 * reachable from outside, pinned.
 *
 * Dependabot raises an advisory; nothing stops a later lockfile from walking
 * back past the fix (a revert, a resolution, a copy of an old yarn.lock).
 * This does. Each floor names the advisories it closes and how they reach
 * this API, or would.
 */
function installed(name: string): string {
  return JSON.parse(
    readFileSync(
      resolve(process.cwd(), "node_modules", name, "package.json"),
      "utf8",
    ),
  ).version;
}

/**
 * The copy `parent` loads: its own nested one when yarn could not hoist it,
 * else the top-level one.
 */
function installedUnder(parent: string, name: string): string {
  const nested = resolve(
    process.cwd(),
    "node_modules",
    parent,
    "node_modules",
    name,
    "package.json",
  );

  return existsSync(nested)
    ? JSON.parse(readFileSync(nested, "utf8")).version
    : installed(name);
}

function manifest(): {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
} {
  return JSON.parse(
    readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
  );
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);

    if (statSync(path).isDirectory()) return sourceFiles(path);

    return path.endsWith(".ts") ? [path] : [];
  });
}

function parts(version: string): number[] {
  return version.split(".").map((part) => Number.parseInt(part, 10));
}

function atLeast(version: string, floor: string): boolean {
  const a = parts(version);
  const b = parts(floor);

  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index];
  }

  return true;
}

function within(version: string, from: string, to: string): boolean {
  return atLeast(version, from) && atLeast(to, version);
}

describe("nodemailer", () => {
  // The recipient of a customer notice comes from an imported NF-e or
  // spreadsheet, and reaches the address parser inside the API process:
  // GHSA-rcmh-qjqh-p98v (recursion, < 7.0.11), GHSA-2x7j-588g-ccc2
  // (quadratic list parsing, < 9.1.0) and GHSA-v53p-9fqp-m79j (free-text
  // backtracking, <= 10.0.5) each stall or crash it with one address.
  // 10.1.4 carries the last parser fixes of the moderates (a mailbox read
  // out of a comment or the display text, delivered to another domain).
  it("is at least 10.1.4", () => {
    const version = installed("nodemailer");

    expect(atLeast(version, "10.1.4"), `nodemailer@${version}`).toBe(true);
  });

  // 10.0.0 to 10.0.11 ignored requireTLS (fixed in 10.0.12): AUTH, with the
  // Resend key, went in plain text to whoever stripped the STARTTLS offer.
  it("is not one of the releases that ignored requireTLS", () => {
    const version = installed("nodemailer");

    expect(within(version, "10.0.0", "10.0.11"), `nodemailer@${version}`).toBe(
      false,
    );
  });

  it("is what package.json pins, with its own types", () => {
    const { dependencies, devDependencies } = manifest();

    expect(dependencies.nodemailer).toBe(installed("nodemailer"));

    // 10.x ships its declarations: a stale @types/nodemailer would type the
    // 6.x API over the 10.x code.
    expect(devDependencies["@types/nodemailer"]).toBeUndefined();
    expect(
      existsSync(
        resolve(process.cwd(), "node_modules", "@types", "nodemailer"),
      ),
    ).toBe(false);
  });
});

describe("zod", () => {
  // Every authenticated body reaches zod before any handler, and zod 3 kept
  // parsing, and reporting, each element of a list after its .max() failed:
  // GHSA-mrhx-c7xc-m3w5 (unbounded memory on oversized arrays, < 4.6.6). One
  // ~7 MB import-xml took the replica's 768 MB heap down
  // (tests/unitaires/http/oversized-array.test.ts).
  it("is at least 4.6.6", () => {
    const version = installed("zod");

    expect(atLeast(version, "4.6.6"), `zod@${version}`).toBe(true);
  });

  it("is what package.json pins, with a type provider made for zod 4", () => {
    const { dependencies } = manifest();

    expect(dependencies.zod).toBe(installed("zod"));

    // The type provider runs the route validation: a 4.x of it still
    // validates with zod 3's API (and documents through zod-to-json-schema,
    // which is zod 3 only).
    const provider = installed("fastify-type-provider-zod");

    expect(dependencies["fastify-type-provider-zod"]).toBe(provider);
    expect(
      atLeast(provider, "7.0.0"),
      `fastify-type-provider-zod@${provider}`,
    ).toBe(true);
  });

  // zod/v3 inside zod 4 is the old code, unchanged (issue #6653): importing
  // it would silence the advisory and keep the bug.
  it("is never imported through its zod 3 subpath", () => {
    const offenders = sourceFiles(resolve(process.cwd(), "src")).filter(
      (file) =>
        /from\s+["']zod\/v3["']|require\(\s*["']zod\/v3["']\s*\)/.test(
          readFileSync(file, "utf8"),
        ),
    );

    expect(offenders).toEqual([]);
  });
});

describe("@fastify/static", () => {
  // Not reachable today: in production it only serves swagger-ui's public
  // files under /docs/static/*, and no guard of ours sits in front of them
  // (the Basic-auth hook is on the UI's routes, not on the static ones).
  // Below 10.1.4, a guard put there later would be bypassed:
  // GHSA-83w8-p2f5-377r (path traversal, <= 10.1.0), GHSA-8pvw-jcv7-9cmj
  // (non-canonical path, <= 10.1.1), GHSA-423g-23ch-w7c6 (non-canonical path
  // segments, < 10.1.3), GHSA-x428-ghpx-8j92 (encoded separator, <= 9.1.0)
  // and GHSA-r799-r9gc-m956 (case-insensitive file systems, fixed in
  // 10.1.4). And a registration that turned directory listing on (none does)
  // would expose GHSA-pr96-94w5-mx2h (path traversal in the listing,
  // <= 9.1.0).
  it("is at least 10.1.4, in the copy swagger-ui loads too", () => {
    const version = installed("@fastify/static");

    expect(atLeast(version, "10.1.4"), `@fastify/static@${version}`).toBe(true);

    // swagger-ui asks for ^10.1.0, which yarn keeps at whatever the lockfile
    // first resolved: bumping only the direct pin leaves the UI's assets on
    // an older copy, nested under it.
    expect(installedUnder("@fastify/swagger-ui", "@fastify/static")).toBe(
      version,
    );
  });

  it("is what package.json pins", () => {
    const { dependencies } = manifest();

    expect(dependencies["@fastify/static"]).toBe(installed("@fastify/static"));
  });
});
