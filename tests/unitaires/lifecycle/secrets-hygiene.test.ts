import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Secrets stay out of the repository, and a new one is caught (INFRA-21).
 *
 * The history already carries .env.development and .env.test (c84bfd4 ...
 * a92c1de) — with a third-party API key among them — and nothing scanned
 * for it. The branch CI now runs gitleaks over every commit; the findings
 * that were already in the history are listed in .gitleaksignore, so the job
 * is green today and red on the next one. And the key files that live next
 * to the repositories (the Firebase admin SDK key, service accounts) cannot
 * be added by accident.
 */
const ROOT = process.cwd();

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

describe("the .gitignore", () => {
  it.each([
    ".env",
    ".env.test",
    ".env.production.local",
    "trajetto-640d0-firebase-adminsdk-fbsvc-0a1b2c3d4e.json",
    "google-firebase-services/trajetto-firebase-adminsdk-x.json",
    "service-account.json",
    "gcp-service-account-prod.json",
    "certificado-a1.pfx",
    "certs/proof-signing.p12",
    "infra/backup/backup-identity.txt",
    "deploy.key",
    "src/tmp/avatar.jpg",
  ])("keeps %s out", (path) => {
    expect(isIgnored(path)).toBe(true);
  });

  it("lets .env.example in", () => {
    expect(isIgnored(".env.example")).toBe(false);
  });
});

describe("the branch CI", () => {
  const ci = readFileSync(resolve(ROOT, ".github/workflows/ci.yml"), "utf8");

  it("scans the whole history with gitleaks, pinned by digest", () => {
    expect(ci).toMatch(/fetch-depth: 0/);
    expect(ci).toMatch(/zricethezav\/gitleaks:v8[\d.]+@sha256:[0-9a-f]{64}/);
    expect(ci).toMatch(/gitleaks git \/repo --redact[^\n]*--exit-code 1/);
  });

  // gitleaks' generic rule fires on any `PASSWORD = "…"`: the tests' fake
  // passwords and tokens, and the empty assignments of .env.example. The
  // work waiting to be committed already had 11 of them, so the first push
  // would turn the job red for good. Quieted for that rule and those paths
  // only: a provider key (Anthropic, GitHub, AWS, …) in a test still fails.
  it("keeps every default rule and quiets only the generic one, only on fixtures", () => {
    const path = resolve(ROOT, ".gitleaks.toml");

    expect(existsSync(path), ".gitleaks.toml").toBe(true);

    const config = readFileSync(path, "utf8").replace(/^\s*#.*$/gm, "");

    expect(config).toMatch(/^\[extend\]\s*\n\s*useDefault\s*=\s*true\s*$/m);
    expect(config).not.toMatch(/^\[allowlist\]/m);
    expect(config).not.toMatch(/^\[\[rules\]\]/m);

    const allowlists = config.split(/^\[\[allowlists\]\]\s*$/m).slice(1);

    expect(allowlists).toHaveLength(1);
    expect(allowlists[0]).toMatch(/^targetRules\s*=\s*\[\s*"generic-api-key"\s*\]\s*$/m);
    expect(allowlists[0]).not.toMatch(/^\s*(?:commits|regexes|stopwords)\s*=/m);

    const paths = [...allowlists[0].matchAll(/'''([^']+)'''/g)].map((match) => match[1]);

    expect(paths.length).toBeGreaterThan(0);
    expect(paths.filter((entry) => !/^\^tests\/$|^\^\\\.env\\\.example\$$/.test(entry))).toEqual([]);
  });

  it("baselines the findings the history already had, by fingerprint", () => {
    const ignore = resolve(ROOT, ".gitleaksignore");

    expect(existsSync(ignore)).toBe(true);

    const fingerprints = readFileSync(ignore, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));

    expect(fingerprints.length).toBeGreaterThan(0);

    // commit:file:rule:line — never a path glob, which would also hide the
    // next leak in the same file.
    for (const fingerprint of fingerprints) {
      expect(fingerprint).toMatch(/^[0-9a-f]{40}:[^:]+:[\w-]+:\d+$/);
    }
  });
});

/** The jobs of a workflow by key: from `  <key>:` up to the next job. */
function jobsOf(workflow: string): Map<string, string> {
  const section = workflow.slice(workflow.search(/^jobs:\s*$/m));
  const chunks = section.split(/\r?\n(?= {2}[\w-]+:\s*\r?\n)/).slice(1);

  return new Map(chunks.map((chunk) => [/^ {2}([\w-]+):/.exec(chunk)![1], chunk]));
}

/** `needs: a` or `needs: [a, b]`, the two forms these workflows use. */
function needsOf(job: string): string[] {
  const needs = /^ {4}needs:\s*(.+)$/m.exec(job)?.[1] ?? "";

  return needs
    .replace(/[[\]]/g, "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

/** The `docker run … gitleaks …` command of a job, whitespace-insensitive. */
function gitleaksCommand(job: string): string {
  const command = /docker run[^\n]*\\\s*\n[^\n]*zricethezav\/gitleaks[\s\S]*?--exit-code 1"/.exec(job)?.[0] ?? "";

  return command.replace(/\s+/g, " ");
}

/**
 * main never ran the scan (INFRA-21): ci.yml only triggers on the other
 * branches, so a direct push or a merge that brought a key in built and
 * published an image anyway. deploy.yml runs the same scan — same image,
 * same flags, same .gitleaksignore — and no image is built before it passes.
 */
describe("the deploy pipeline", () => {
  const ci = jobsOf(readFileSync(resolve(ROOT, ".github/workflows/ci.yml"), "utf8"));
  const deploy = jobsOf(readFileSync(resolve(ROOT, ".github/workflows/deploy.yml"), "utf8"));

  it("scans the whole history exactly as the branch CI does", () => {
    const scan = deploy.get("secrets") ?? "";

    expect(scan, "secrets job in deploy.yml").toMatch(/fetch-depth: 0/);
    expect(gitleaksCommand(scan)).not.toBe("");
    expect(gitleaksCommand(scan)).toBe(gitleaksCommand(ci.get("secrets") ?? ""));
  });

  it("builds no image before the scan passes", () => {
    const builds = [...deploy].filter(([, job]) => /uses: docker\/build-push-action@/.test(job));

    expect(builds.length).toBeGreaterThan(0);

    for (const [name, job] of builds) expect(needsOf(job), name).toContain("secrets");
  });
});
