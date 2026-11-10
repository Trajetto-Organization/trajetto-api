import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The versions below which a production dependency is known to be
 * reachable from outside, pinned.
 *
 * Dependabot raises an advisory; nothing stops a later lockfile from walking
 * back past the fix (a revert, a resolution, a copy of an old yarn.lock).
 * This does. Each floor names the advisories it closes and why they reach
 * this API.
 */
function installed(name: string): string {
  return JSON.parse(
    readFileSync(
      resolve(process.cwd(), "node_modules", name, "package.json"),
      "utf8",
    ),
  ).version;
}

function manifest(): {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
} {
  return JSON.parse(
    readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
  );
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
