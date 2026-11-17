import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Who may use the two side pools of infra/database.ts (plano-escala F3-16,
 * section 2.4 of the plan). Each is a closed list, kept here:
 *
 *  - databaseRead is the heavy reads' bulkhead, and from wave 17 its URL
 *    may point at the standby, seconds behind the primary. A middleware, a
 *    socket admission, a queue claim, an idempotency key or a
 *    compare-and-set reading it would decide on a stale row: a revoked
 *    session let through, a job claimed twice, a write replayed. Those
 *    paths may never import it, whatever the list says.
 *  - databaseBatch runs with a 30-minute statement ceiling and, after the
 *    cut of the database roles, as trajetto_batch (pg_read_all_stats, the
 *    partitions' owner): it is for the maintenance that runs in the cron
 *    process, never a request's work.
 *
 * Read from every .ts under src/ by the TypeScript parser: the named
 * imports of the module infra/database, however the path is spelled.
 */
const ROOT = process.cwd();

/** Who may read through the bulkhead. F3-17 fills it, read by read. */
const READ_ALLOWED: string[] = [];

/** Where a stale read is a wrong decision: never databaseRead. */
const READ_FORBIDDEN = [
  /^src\/modules\/middlewares\//,
  /^src\/websocket\.ts$/,
  /^src\/shared\/socket\//,
  /^src\/workers\//,
  /idempoten/i,
  /claim/i,
];

/** Who may run on the maintenance pool: the crons and what they call. */
const BATCH_ALLOWED: RegExp[] = [/^src\/jobs\/cron\/[^/]+\.ts$/];

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);

    if (name === "node_modules") return [];

    return statSync(path).isDirectory()
      ? filesUnder(path)
      : path.endsWith(".ts")
        ? [path]
        : [];
  });
}

/** The names a file imports from infra/database. */
function databaseImports(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest);
  const names: string[] = [];

  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !/(^|\/)infra\/database$/.test(statement.moduleSpecifier.text)
    ) {
      continue;
    }

    const bindings = statement.importClause?.namedBindings;

    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        names.push((element.propertyName ?? element.name).text);
      }
    }
  }

  return names;
}

function importersOf(name: string): string[] {
  return filesUnder(resolve(ROOT, "src"))
    .map((path) => relative(ROOT, path).replace(/\\/g, "/"))
    .filter((file) =>
      databaseImports(file, readFileSync(resolve(ROOT, file), "utf8")).includes(
        name,
      ),
    )
    .sort();
}

describe("the side pools of infra/database.ts", () => {
  it("lets only the closed list read through databaseRead", () => {
    expect(importersOf("databaseRead")).toEqual([...READ_ALLOWED].sort());
  });

  it("never lets a middleware, a socket, a claim or an idempotency path read the bulkhead", () => {
    for (const file of READ_ALLOWED) {
      for (const pattern of READ_FORBIDDEN) {
        expect(pattern.test(file), `${file} ~ ${pattern}`).toBe(false);
      }
    }
  });

  it("keeps databaseBatch to the crons and the maintenance they run", () => {
    const outside = importersOf("databaseBatch").filter(
      (file) => !BATCH_ALLOWED.some((pattern) => pattern.test(file)),
    );

    expect(outside).toEqual([]);
  });

  it("reads the imports it is meant to check", () => {
    // Proof the parser sees the real imports: the app's own client is
    // imported all over src/.
    const sample = `import database, { databasePool, databaseBatch as batch } from "@/../infra/database";`;

    expect(databaseImports("sample.ts", sample)).toEqual([
      "databasePool",
      "databaseBatch",
    ]);
    expect(importersOf("databasePool").length).toBeGreaterThan(0);
  });
});
