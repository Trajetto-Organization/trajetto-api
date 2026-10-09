import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Every npm script points at a file that exists.
 *
 * `osrm:dev:*` kept starting compose.osrm-development.yaml and `r2:cors` kept
 * running infra/scripts/configure-r2-cors.ts after both files were deleted
 * (81a14dd): the README still told people to run them, and each failed with a
 * missing-file error far from the reason. Compiled outputs (build/) are not
 * checked — they only exist after `yarn build`.
 */
const ROOT = process.cwd();
const scripts: Record<string, string> = JSON.parse(
  readFileSync(resolve(ROOT, "package.json"), "utf8"),
).scripts;

/** Files a script names: `-f <compose>` and `tsx|node <source>`. */
function referenced(command: string): string[] {
  const composes = [...command.matchAll(/(?:^|\s)-f\s+(\S+\.ya?ml)/g)].map((m) => m[1]);
  const sources = [...command.matchAll(/(?:^|\s)(?:tsx|node)\s+(?:watch\s+)?(\S+\.[cm]?[jt]s)/g)]
    .map((m) => m[1])
    .filter((path) => !path.startsWith("build/"));

  return [...composes, ...sources];
}

describe("package.json scripts", () => {
  it("reads the files a script names", () => {
    expect(referenced("docker compose -f compose.x.yaml up -d db")).toEqual(["compose.x.yaml"]);
    expect(referenced("tsx infra/scripts/seed.ts")).toEqual(["infra/scripts/seed.ts"]);
    expect(referenced("tsx watch src/server.ts")).toEqual(["src/server.ts"]);
    expect(referenced("node build/server.js")).toEqual([]);
  });

  it.each(Object.entries(scripts))("%s points at files that exist", (_name, command) => {
    const missing = referenced(command).filter((path) => !existsSync(resolve(ROOT, path)));

    expect(missing).toEqual([]);
  });

  it("has one name per command: an alias is a second name to document and keep in sync", () => {
    // test:integration was test:e2e under its old name (README-META-1).
    const normalised = (command: string) => command.replace(/\.\//g, "").replace(/\s+/g, " ").trim();
    const byCommand = new Map<string, string[]>();

    for (const [name, command] of Object.entries(scripts)) {
      byCommand.set(normalised(command), [...(byCommand.get(normalised(command)) ?? []), name]);
    }

    expect([...byCommand.values()].filter((names) => names.length > 1)).toEqual([]);
  });

  it("gates the unit coverage at the measured baseline minus one point", () => {
    // Baseline in docs/testes.md ("Cobertura"), unit run:
    // statements/lines 71.80%, branches 83.57%, functions 58.62%. One point
    // below, so a new test file never fails CI, a deleted one does.
    const thresholds = Object.fromEntries(
      [...scripts["test:coverage"].matchAll(/--coverage\.thresholds\.(\w+)=([\d.]+)/g)].map(
        ([, metric, value]) => [metric, Number(value)],
      ),
    );

    expect(thresholds).toEqual({ statements: 70.8, lines: 70.8, branches: 82.57, functions: 57.62 });
  });
});
