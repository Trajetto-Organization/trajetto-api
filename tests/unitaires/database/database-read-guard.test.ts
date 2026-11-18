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

/**
 * Who may read through the bulkhead, method by method (plano-escala F3-17):
 * the exports, the MASTER's lists, the activities' lists and summary, and
 * the LISTS of /integration/v1/deliveries and /routes. The rest of these
 * repositories stays on the primary: /integration/v1/events and one
 * delivery or route an ERP reads right after writing it, the Torre, the
 * activities' scope (who may see what), sessions, claims, idempotency and
 * every compare-and-set.
 */
const READ_ALLOWED: Record<string, string[]> = {
  "src/modules/account-payable/repositories/account-payable-repository.ts": [
    "streamAccountPayablesForExport",
  ],
  "src/modules/activity/repositories/activity-repository.ts": [
    "listActivitiesWithCursor",
    "listAllActivities",
    "summarizeActivities",
  ],
  "src/modules/business/repositories/business-repository.ts": ["listBusiness"],
  "src/modules/delivery/repositories/delivery-repository.ts": [
    "streamDeliveriesForExport",
    "streamOccurrencesForExport",
  ],
  "src/modules/driver/repositories/driver-repository.ts": [
    "countDriversForExport",
    "streamDriversForExport",
  ],
  "src/modules/fine/repositories/fine-repository.ts": [
    "countFinesForExport",
    "streamFinesForExport",
  ],
  "src/modules/fuel/repositories/fuel-repository.ts": [
    "countFuelForExport",
    "streamFuelsForExport",
  ],
  "src/modules/integration/repositories/integration-repository.ts": [
    "listDeliveries",
    "listRoutes",
  ],
  "src/modules/quote/repositories/quote-repository.ts": ["listQuotes"],
  "src/modules/service-order/repositories/service-order-repository.ts": [
    "countServiceOrderForExport",
    "streamServiceOrdersForExport",
  ],
  "src/modules/user/repositories/user-repository.ts": ["listMasterUsers"],
  "src/modules/vehicle-checklist/repositories/vehicle-checklist-repository.ts":
    ["countChecklistForExport", "streamChecklistsForExport"],
  "src/modules/vehicle/repositories/vehicle-repository.ts": [
    "countVehiclesForExport",
    "streamVehiclesForExport",
  ],
};

/**
 * Method names that decide on the latest write, whatever file they are in:
 * a session, a claim, an idempotency key, a lock, a compare-and-set, the
 * events feed (its cursor must never skip a commit) or a submission an ERP
 * just sent.
 */
const READ_FORBIDDEN_METHOD =
  /claim|idempoten|session|lock|compareAndSet|cas[A-Z]|event|submission|admi/i;

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

/**
 * The methods of a file that read through the bulkhead: those whose body
 * names `this.read` (the repositories' handle on it) or databaseRead. The
 * `read` getter, which only hands the handle out, is not a read.
 */
function bulkheadMethods(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const methods = new Set<string>();

  const readsBulkhead = (node: ts.Node): boolean => {
    let found = false;

    const visit = (child: ts.Node) => {
      if (found) return;

      if (
        (ts.isPropertyAccessExpression(child) &&
          child.expression.kind === ts.SyntaxKind.ThisKeyword &&
          child.name.text === "read") ||
        (ts.isIdentifier(child) && child.text === "databaseRead")
      ) {
        found = true;

        return;
      }

      ts.forEachChild(child, visit);
    };

    visit(node);

    return found;
  };

  const visit = (node: ts.Node) => {
    if (
      (ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) &&
      node.name &&
      node.body &&
      readsBulkhead(node.body)
    ) {
      methods.add(node.name.getText(source));
    }

    ts.forEachChild(node, visit);
  };

  visit(source);

  return [...methods].sort();
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
  it("lets only the closed list's files import databaseRead", () => {
    expect(importersOf("databaseRead")).toEqual(
      Object.keys(READ_ALLOWED).sort(),
    );
  });

  it("lets only the closed list's methods read through it, in each file", () => {
    for (const [file, methods] of Object.entries(READ_ALLOWED)) {
      const text = readFileSync(resolve(ROOT, file), "utf8");

      expect(bulkheadMethods(file, text), file).toEqual([...methods].sort());
    }
  });

  it("never lets a middleware, a socket, a claim or an idempotency path read the bulkhead", () => {
    for (const [file, methods] of Object.entries(READ_ALLOWED)) {
      for (const pattern of READ_FORBIDDEN) {
        expect(pattern.test(file), `${file} ~ ${pattern}`).toBe(false);
      }

      for (const method of methods) {
        expect(
          READ_FORBIDDEN_METHOD.test(method),
          `${file}#${method} ~ ${READ_FORBIDDEN_METHOD}`,
        ).toBe(false);
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

    // And the reads it is meant to find: through the handle or the name,
    // never the getter that only hands the handle out.
    const repository = `
      class Sample {
        constructor(private prisma = database) {}
        private get read() { return this.prisma === database ? databaseRead : this.prisma; }
        async listThings() { return this.read.thing.findMany(); }
        async findThing() { return this.prisma.thing.findFirst(); }
      }
      async function countThings() { return databaseRead.thing.count(); }
    `;

    expect(bulkheadMethods("sample.ts", repository)).toEqual([
      "countThings",
      "listThings",
    ]);
  });
});
