import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The repository's own documentation stays one set, and stays reachable.
 *
 * docs/ was consolidated (10/2026) into arquitetura.md, deploy.md, testes.md
 * and variaveis-de-ambiente.md; the eleven runbooks and the uniqueness
 * analysis were folded in and deleted. A comment or a guide that still points
 * at one of them sends the next reader — a person or a fresh agent session —
 * to a file that does not exist. CLAUDE.md and AGENTS.md are the same guide
 * for two kinds of agent: one drifting from the other means one of them
 * lies.
 */
const ROOT = resolve(__dirname, "..", "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8").replace(/\r\n/g, "\n");

const DOCS = ["docs/arquitetura.md", "docs/deploy.md", "docs/testes.md", "docs/variaveis-de-ambiente.md"];

const RETIRED = /docs\/(?:runbook-[\w-]+|decisao-uniques-multi-tenant)\.md/;

/** Text files under `dir`, skipping what is not ours to keep in sync. */
function files(dir: string): string[] {
  const skip = new Set(["node_modules", ".git", "tmp", "coverage", "reports", "build", "docs", "fixtures"]);

  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const path = join(ROOT, dir, name);

    if (skip.has(name)) return [];
    if (statSync(path).isDirectory()) return files(relative(ROOT, path));

    return /\.(ts|mts|mjs|js|sh|ya?ml|md|prisma|toml|json)$|^Dockerfile$|^\.env\.example$|^\.gitleaksignore$/.test(name)
      ? [relative(ROOT, path).replace(/\\/g, "/")]
      : [];
  });
}

describe("the repository documentation", () => {
  it("is the consolidated set", () => {
    const present = readdirSync(join(ROOT, "docs")).filter((name) => name.endsWith(".md")).sort();

    expect(present.map((name) => `docs/${name}`)).toEqual([...DOCS].sort());
  });

  it("is what README, CLAUDE.md and AGENTS.md point at, and every path they cite exists", () => {
    for (const guide of ["README.md", "CLAUDE.md", "AGENTS.md"]) {
      const text = read(guide);
      const cited = [...text.matchAll(/(?<![\w./-])(docs\/[\w-]+\.md)/g)].map((match) => match[1]);

      expect(cited.length, guide).toBeGreaterThan(0);

      for (const path of cited) expect(existsSync(join(ROOT, path)), `${guide} → ${path}`).toBe(true);
    }
  });

  it("is not pointed at by a retired path anywhere outside docs/ and the immutable migrations", () => {
    const stale = files(".")
      .filter((path) => !path.startsWith("prisma/migrations/"))
      .filter((path) => path !== "tests/unitaires/quality/agent-guides.test.ts")
      .filter((path) => path !== "tests/unitaires/lifecycle/compose-stack-render.test.ts")
      .filter((path) => RETIRED.test(read(path)));

    expect(stale).toEqual([]);
  });
});

describe("the agent guides", () => {
  it("say the same thing in CLAUDE.md and AGENTS.md (only the title line differs)", () => {
    const body = (path: string) => read(path).split("\n").slice(1).join("\n");

    expect(read("CLAUDE.md").split("\n")[0]).toMatch(/^# CLAUDE\.md/);
    expect(read("AGENTS.md").split("\n")[0]).toMatch(/^# AGENTS\.md/);
    expect(body("CLAUDE.md")).toBe(body("AGENTS.md"));
  });
});
