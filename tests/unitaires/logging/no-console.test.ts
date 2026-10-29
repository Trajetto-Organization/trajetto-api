import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * One output format for the whole API (OBS-14).
 *
 * Fastify, the workers and the cron scheduler write JSON through the shared
 * pino logger; a `console.*` anywhere in src/ puts free text between those
 * lines — no level a LOG_LEVEL can filter, no `component`, no request id, and
 * whatever the call interpolated (an e-mail, a token in a URL) as plain text
 * instead of a field a redaction rule can reach. Everything under src/ writes
 * through `@/shared/logging/logger`, usually as `logger.child({ component })`.
 *
 * The same holds for the clients under infra/ that src/ imports and that run
 * inside the API process (the database, the Redis cache). The CLI tools
 * under infra/scripts are not part of it: they print to a terminal on
 * purpose.
 *
 * The files below are the exceptions, each for a reason that still has to
 * hold.
 */
const ALLOWED: Record<string, string> = {
  // The logger reads LOG_LEVEL from `env`, so it cannot exist while `env` is
  // still being validated: an invalid environment can only be reported here.
  "src/env/index.ts": "runs before the logger exists (env validation)",

  // Evaluated inside that same validation (superRefine), for the same reason.
  "src/schemas/env-schema/index.ts":
    "runs before the logger exists (env validation)",
};

/** Everything that runs inside the API process. */
const ROOTS = ["src", "infra"];

/** Command-line tools: a terminal is their output. */
const CLI_TOOLS = "infra/scripts/";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) return sourceFiles(path);

    return /\.[cm]?[jt]s$/.test(entry.name) && !entry.name.endsWith(".d.ts")
      ? [path]
      : [];
  });
}

/**
 * Every use of the `console` global, found in the syntax tree — so a
 * `console.log(` inside a comment or a string is not a call, and
 * `console["warn"]` or `const say = console.error` still are.
 */
function consoleUses(
  path: string,
  text = readFileSync(path, "utf8"),
): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);

  const found: string[] = [];

  const visit = (node: ts.Node): void => {
    if (
      (ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "console"
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart());

      found.push(`${line + 1}: ${node.getText(source)}`);
    }

    ts.forEachChild(node, visit);
  };

  visit(source);

  return found;
}

const files = ROOTS.flatMap((root) => sourceFiles(resolve(process.cwd(), root)))
  .map((path) => ({
    path,
    name: relative(process.cwd(), path).split("\\").join("/"),
  }))
  .filter(({ name }) => !name.startsWith(CLI_TOOLS));

describe("the API process (src/ and the clients under infra/)", () => {
  it("writes through the shared logger, never console.*", () => {
    const offenders = files
      .filter(({ name }) => !(name in ALLOWED))
      .flatMap(({ path, name }) =>
        consoleUses(path).map((use) => `${name}:${use}`),
      );

    expect(offenders).toEqual([]);
  });

  it("keeps no exemption that is no longer needed", () => {
    // An allowlist entry for a file that stopped using console is a hole the
    // next console.log walks through unnoticed.
    const stale = Object.keys(ALLOWED).filter((name) => {
      const file = files.find((entry) => entry.name === name);

      return !file || consoleUses(file.path).length === 0;
    });

    expect(stale).toEqual([]);
  });

  it("finds a call hidden from a text search, and ignores one in a comment", () => {
    // The detector itself: a regression here would pass the checks above
    // vacuously.
    const uses = consoleUses(
      "probe.ts",
      [
        "// console.log('in a comment')",
        "const text = 'console.error(1)';",
        "console['warn']('by index');",
        "const say = console.info;",
      ].join("\n"),
    );

    expect(uses).toEqual(["3: console['warn']", "4: console.info"]);
  });
});
