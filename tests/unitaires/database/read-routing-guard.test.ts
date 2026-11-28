import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * What may be read on the standby (plano-escala F4-42, the security
 * review). readDatabase() (infra/database.ts) sends a read to the standby
 * while the replica guard measures it at most 15 s behind (F4-41), so a
 * read there may miss up to 15 s of writes. On a list that is a row that
 * shows up a moment later. On a write's path it is a wrong decision: a GET
 * right after a POST answers 404, a garbage collector deletes an object
 * that was just referenced, a claim or an idempotency key lets a job or a
 * write through twice, a compare-and-set compares against the past.
 *
 * So the standby gets a closed list of LISTS only: the exports, the
 * MASTER's lists, the activities, and the lists of /integration/v1/deliveries
 * and /routes, each a method of a repository reading through its `read`
 * getter (or, for an export's batches, its `readWalk`). And these never
 * reach it, directly (readDatabase) or through one of those methods: a
 * middleware, the socket admission, the queue's claims and workers,
 * idempotency, the integration's create and cancel (and their replay), the
 * orphan uploads' collector, a tenant's purge and a person's anonymization,
 * and every *-usecase that writes.
 *
 * And a list there never pages with Prisma's `cursor` on a server chosen
 * per call (the review of wave 17): Prisma looks the cursor's row up and
 * answers an empty page when it is not there, and the page before may have
 * come from the primary, with a row the standby has not replayed yet. The
 * list would end there, without every row after it, of any age. A cursor
 * that came in a request pages by value (`id > cursor`); an export's own
 * batches go through one walk (readDatabaseWalk), which never goes from
 * the primary back to the standby.
 *
 * Read from every .ts under src/ by the TypeScript parser where it names a
 * method, and by its text where it names a call.
 */
const ROOT = process.cwd();

/** The lists the standby may serve, method by method. */
const REPLICA_LISTS: Record<string, string[]> = {
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

/** A list, a stream, a count or a summary: never one row by its id. */
const LIST_NAME = /^(?:list|stream|count|summarize)[A-Z]/;

/** A name that decides on the latest write, whatever it starts with. */
const DECIDING_NAME =
  /claim|idempoten|session|lock|compareAndSet|cas[A-Z]|event|submission|admi|byId|ById/i;

/** Where a row seconds old is a wrong decision. */
const NEVER_ON_REPLICA: Array<[RegExp, string]> = [
  [/^src\/modules\/middlewares\//, "middleware"],
  [/^src\/websocket\.ts$/, "admissão de socket"],
  [/^src\/shared\/socket\//, "admissão de socket"],
  [/^src\/workers\//, "worker de fila"],
  [/^src\/shared\/queue\//, "claim de fila"],
  [/claim/i, "claim"],
  [/idempoten/i, "idempotência"],
  [
    /^src\/modules\/integration\/usecases\/create-delivery\//,
    "create de integração e o replay",
  ],
  [
    /^src\/modules\/integration\/usecases\/cancel-delivery\//,
    "cancelamento de integração",
  ],
  [/^src\/jobs\/cron\/cleanup-orphan-uploads-job\.ts$/, "GC de uploads órfãos"],
  [/^src\/shared\/services\/orphan-uploads\.ts$/, "GC de uploads órfãos"],
  [/^src\/shared\/jobs\/tenant-offboard\//, "expurgo de tenant"],
  [/^src\/shared\/jobs\/user-anonymize\//, "anonimização"],
];

/** A call that writes: a repository's create/update/delete, a transaction, raw DML. */
const WRITES =
  /\.(?:create|update|delete|upsert|insert|remove|save)[A-Za-z]*\(|\$transaction\b|\$executeRaw/;

/** Who may name readDatabase at all: the router and the lists' getters. */
const ROUTER = "infra/database.ts";

/**
 * The router's functions, each named only inside its handle in a listed
 * repository: the `read` getter (one choice per call) and the `readWalk`
 * method (one walk per export).
 */
const HANDLES = { read: "readDatabase", readWalk: "readDatabaseWalk" } as const;

interface SourceFile {
  path: string;
  text: string;
}

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

function sourceTree(): SourceFile[] {
  return filesUnder(resolve(ROOT, "src")).map((path) => ({
    path: relative(ROOT, path).replace(/\\/g, "/"),
    text: readFileSync(path, "utf8"),
  }));
}

/** Code without comments: a comment naming a method is not a call. */
function codeOf(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** Whether a node names one of `handles` on `this`, or one of `functions`. */
function mentions(
  node: ts.Node,
  handles: readonly string[],
  functions: readonly string[],
): boolean {
  let found = false;

  const visit = (child: ts.Node) => {
    if (found) return;
    if (
      (ts.isPropertyAccessExpression(child) &&
        child.expression.kind === ts.SyntaxKind.ThisKeyword &&
        handles.includes(child.name.text)) ||
      (ts.isIdentifier(child) && functions.includes(child.text))
    ) {
      found = true;

      return;
    }
    ts.forEachChild(child, visit);
  };

  visit(node);

  return found;
}

interface Method {
  name: string;
  node: ts.FunctionLikeDeclaration;
  body: ts.Node;
}

/** The methods (and functions) of a file, by name, with their bodies. */
function methodsOf(file: string, text: string): Method[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: Method[] = [];

  const visit = (node: ts.Node) => {
    if (
      (ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) &&
      node.name &&
      node.body
    ) {
      found.push({ name: node.name.getText(source), node, body: node.body });
    }
    ts.forEachChild(node, visit);
  };

  visit(source);

  return found;
}

/**
 * The methods of a file that read through readDatabase: those whose body
 * names `this.read` or `this.readWalk` (the repositories' handles on it),
 * readDatabase or readDatabaseWalk. The handles themselves, which only hand
 * the client out, are not reads.
 */
function replicaMethods(file: string, text: string): string[] {
  const methods = new Set<string>();

  for (const { name, body } of methodsOf(file, text)) {
    if (name in HANDLES) continue;
    if (mentions(body, Object.keys(HANDLES), Object.values(HANDLES))) {
      methods.add(name);
    }
  }

  return [...methods].sort();
}

/**
 * Whether a file names readDatabase outside its `read` getter, or
 * readDatabaseWalk outside its `readWalk` method.
 */
function readDatabaseOutsideGetter(file: string, text: string): boolean {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const routerNames: readonly string[] = Object.values(HANDLES);
  let outside = false;

  const handleOf = (node: ts.Node): keyof typeof HANDLES | null => {
    if (
      ts.isGetAccessorDeclaration(node) &&
      node.name.getText(source) === "read"
    ) {
      return "read";
    }
    if (
      ts.isMethodDeclaration(node) &&
      node.name.getText(source) === "readWalk"
    ) {
      return "readWalk";
    }

    return null;
  };

  const visit = (node: ts.Node, inHandle: keyof typeof HANDLES | null) => {
    const handle = handleOf(node) ?? inHandle;

    if (ts.isIdentifier(node) && routerNames.includes(node.text)) {
      const inImport = ts.findAncestor(node, ts.isImportDeclaration);
      const own = handle ? HANDLES[handle] : null;

      if (!inImport && own !== node.text) outside = true;
    }
    ts.forEachChild(node, (child) => visit(child, handle));
  };

  visit(source, null);

  return outside;
}

/** Whether a node holds Prisma's `cursor: { ... }` (an object literal). */
function prismaCursor(node: ts.Node): boolean {
  let found = false;

  const visit = (child: ts.Node) => {
    if (found) return;
    if (
      ts.isPropertyAssignment(child) &&
      ts.isIdentifier(child.name) &&
      child.name.text === "cursor" &&
      ts.isObjectLiteralExpression(child.initializer)
    ) {
      found = true;

      return;
    }
    ts.forEachChild(child, visit);
  };

  visit(node);

  return found;
}

/** Whether a function takes something named `cursor`, however bound. */
function takesCursor(node: ts.FunctionLikeDeclaration): boolean {
  const bound = (name: ts.BindingName): boolean =>
    ts.isIdentifier(name)
      ? name.text === "cursor"
      : name.elements.some(
          (element) =>
            !ts.isOmittedExpression(element) &&
            ((element.propertyName &&
              ts.isIdentifier(element.propertyName) &&
              element.propertyName.text === "cursor") ||
              bound(element.name)),
        );

  return node.parameters.some((parameter) => bound(parameter.name));
}

/**
 * The paging rules of the standby's lists, one line per problem: Prisma's
 * cursor only inside a walk (never on `this.read`, chosen per call), and a
 * walk never over a cursor that came in from outside.
 */
function pagingProblems(file: string, text: string): string[] {
  const problems: string[] = [];

  for (const { name, node, body } of methodsOf(file, text)) {
    if (name in HANDLES) continue;

    const perCall = mentions(body, ["read"], [HANDLES.read]);
    const walk = mentions(body, ["readWalk"], [HANDLES.readWalk]);

    if (perCall && prismaCursor(body)) {
      problems.push(
        `${file}#${name}: pagina com o cursor do Prisma numa leitura escolhida a cada chamada`,
      );
    }
    if (walk && takesCursor(node)) {
      problems.push(
        `${file}#${name}: walk sobre um cursor que veio de fora (pagine pelo valor)`,
      );
    }
  }

  return problems;
}

/**
 * Whether a file imports readDatabase from infra/database, however the
 * path is spelled. (A property of the same name, the metrics reader of
 * shared/health/cluster-sample.ts, is something else.)
 */
function importsReadDatabase(
  file: string,
  text: string,
  name = "readDatabase",
): boolean {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest);

  return source.statements.some((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !/(^|\/)infra\/database$/.test(statement.moduleSpecifier.text)
    ) {
      return false;
    }

    const bindings = statement.importClause?.namedBindings;

    return (
      !!bindings &&
      ts.isNamedImports(bindings) &&
      bindings.elements.some(
        (element) => (element.propertyName ?? element.name).text === name,
      )
    );
  });
}

/**
 * /integration/v1/events on the standby (plano-escala F4-43): not one of
 * the lists (its cursor must never skip a commit), so not through
 * readDatabase. Only the commit walk, only behind
 * INTEGRATION_EVENTS_READ_REPLICA, through replicaDatabase(), whose
 * fallback is the application's pool; its horizon is the standby's own
 * snapshot (tests/E2E/infra/events-on-standby.test.ts).
 */
const EVENTS_ON_REPLICA = {
  file: "src/modules/integration/repositories/integration-repository.ts",
  method: "listEventsByCommit",
  flag: "env.INTEGRATION_EVENTS_READ_REPLICA",
};

/** The methods of a file whose body calls `this.standby(` (the events' handle). */
function standbyMethods(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const methods: string[] = [];

  const visit = (node: ts.Node) => {
    if (
      ts.isMethodDeclaration(node) &&
      node.body &&
      /\bthis\.standby\(/.test(node.body.getText(source))
    ) {
      methods.push(node.name.getText(source));
    }
    ts.forEachChild(node, visit);
  };

  visit(source);

  return methods;
}

/** The replica's method names, called anywhere in a file's code. */
function replicaCalls(text: string): string[] {
  const code = codeOf(text);
  const names = new Set(Object.values(REPLICA_LISTS).flat());

  return [...names].filter((name) => new RegExp(`\\.${name}\\(`).test(code));
}

/** Every rule of this file over a tree: one line per problem. */
function routingProblems(tree: SourceFile[]): string[] {
  const problems: string[] = [];

  for (const { path, text } of tree) {
    const code = codeOf(text);
    const names =
      importsReadDatabase(path, text) ||
      importsReadDatabase(path, text, HANDLES.readWalk);
    const listed = path in REPLICA_LISTS;

    // readDatabase itself: only in the lists' getters.
    if (names && !listed) {
      problems.push(`${path}: usa readDatabase fora da lista fechada`);
    }
    if (listed && readDatabaseOutsideGetter(path, text)) {
      problems.push(`${path}: usa readDatabase fora do getter read`);
    }
    // And how its lists page.
    if (listed) problems.push(...pagingProblems(path, text));

    // replicaDatabase: the events' commit walk alone, behind its flag.
    const events = importsReadDatabase(path, text, "replicaDatabase");

    if (events && path !== EVENTS_ON_REPLICA.file) {
      problems.push(`${path}: usa replicaDatabase fora do feed de eventos`);
    }
    if (path === EVENTS_ON_REPLICA.file) {
      const callers = standbyMethods(path, text);

      if (callers.join() !== EVENTS_ON_REPLICA.method) {
        problems.push(
          `${path}: o standby dos eventos lido em ${callers.join(", ") || "nenhum método"}`,
        );
      }
      if (!code.includes(`${EVENTS_ON_REPLICA.flag} ? this.standby() : null`)) {
        problems.push(`${path}: o standby dos eventos sem a variável`);
      }
    }

    for (const [pattern, place] of NEVER_ON_REPLICA) {
      if (!pattern.test(path)) continue;
      if (names) problems.push(`${path}: readDatabase em ${place}`);
      if (events) problems.push(`${path}: replicaDatabase em ${place}`);
      for (const call of replicaCalls(text)) {
        problems.push(`${path}: ${call} (lê do standby) em ${place}`);
      }
    }

    if (/-usecase\.ts$/.test(path) && WRITES.test(code)) {
      for (const call of replicaCalls(text)) {
        problems.push(
          `${path}: ${call} (lê do standby) num usecase que escreve`,
        );
      }
    }
  }

  return problems;
}

describe("the reads readDatabase may send to the standby", () => {
  const tree = sourceTree();

  it("are the closed list's, method by method, in each file", () => {
    for (const [file, methods] of Object.entries(REPLICA_LISTS)) {
      const found = tree.find((each) => each.path === file);

      // A renamed file would make this check pass without checking.
      expect(found, file).toBeDefined();
      expect(replicaMethods(file, found!.text), file).toEqual(
        [...methods].sort(),
      );
    }

    // And nowhere else: no other file reads through it.
    const others = tree
      .filter(({ path }) => !(path in REPLICA_LISTS))
      .filter(({ path, text }) => replicaMethods(path, text).length > 0)
      .filter(({ path, text }) => importsReadDatabase(path, text))
      .map(({ path }) => path);

    expect(others).toEqual([]);
  });

  it("are lists only: never one row by its id, a claim, a session or a compare-and-set", () => {
    for (const [file, methods] of Object.entries(REPLICA_LISTS)) {
      for (const method of methods) {
        expect(LIST_NAME.test(method), `${file}#${method}`).toBe(true);
        expect(DECIDING_NAME.test(method), `${file}#${method}`).toBe(false);
      }
    }
  });

  it("never reach a write's path, a middleware, a claim, idempotency, the orphans' collector or a purge", () => {
    expect(routingProblems(tree)).toEqual([]);
  });

  it("go through the router only: readDatabase is infra/database.ts's, and the side pool of the standby is nobody else's", () => {
    const router = readFileSync(resolve(ROOT, ROUTER), "utf8");

    expect(router).toMatch(/function readDatabase\(\): PrismaClient \{/);
    expect(router).toContain('environmentUrl("DATABASE_REPLICA_URL")');

    for (const { path, text } of tree) {
      expect(/\breplicaGuard\(\)/.test(codeOf(text)), path).toBe(false);
    }
  });
});

describe("the guard itself", () => {
  const tree = sourceTree();
  const at = (path: string) => tree.find((each) => each.path === path)!;

  // The acceptance (plano-escala F4-42): a call planted in a middleware and
  // in the orphans' collector fails the guard.
  it("fails a readDatabase() planted in a middleware", () => {
    const file = at("src/modules/middlewares/ensure-authenticated.ts");
    const planted = {
      path: file.path,
      text: `import { readDatabase } from "@/../infra/database";\n${file.text}\nconst stale = () => readDatabase().user.findFirst();\n`,
    };

    expect(routingProblems([planted])).toEqual(
      expect.arrayContaining([
        `${file.path}: usa readDatabase fora da lista fechada`,
        `${file.path}: readDatabase em middleware`,
      ]),
    );
  });

  it("fails a list of the standby planted in the orphan uploads' collector", () => {
    const file = at("src/jobs/cron/cleanup-orphan-uploads-job.ts");
    const planted = {
      path: file.path,
      text: `${file.text}\nconst seen = (repo: any) => repo.streamDeliveriesForExport({});\n`,
    };

    expect(routingProblems([planted])).toEqual([
      `${file.path}: streamDeliveriesForExport (lê do standby) em GC de uploads órfãos`,
    ]);
  });

  it("fails a list of the standby in a usecase that writes, and a readDatabase outside the getter", () => {
    const usecase = {
      path: "src/modules/sample/usecases/rename-thing/rename-thing-usecase.ts",
      text: `export class RenameThingUseCase { async execute() { const all = await this.repo.listActivitiesWithCursor({}); await this.repo.updateThing(all[0]); } }`,
    };
    const repository = at(
      "src/modules/activity/repositories/activity-repository.ts",
    );
    const bypass = {
      path: repository.path,
      text: `${repository.text}\nconst direct = () => readDatabase().activity.findFirst();\n`,
    };

    expect(routingProblems([usecase, bypass])).toEqual([
      `${usecase.path}: listActivitiesWithCursor (lê do standby) num usecase que escreve`,
      `${repository.path}: usa readDatabase fora do getter read`,
    ]);
  });

  it("keeps the events' standby to the commit walk behind its flag, and fails it anywhere else", () => {
    const repository = at(EVENTS_ON_REPLICA.file);
    const ungated = {
      path: repository.path,
      text: repository.text.replace(
        `${EVENTS_ON_REPLICA.flag} ? this.standby() : null`,
        "this.standby()",
      ),
    };
    const elsewhere = {
      path: "src/modules/middlewares/ensure-api-key.ts",
      text: `import { replicaDatabase } from "@/../infra/database";
export const key = () => replicaDatabase();
`,
    };

    expect(routingProblems([repository])).toEqual([]);
    expect(routingProblems([ungated, elsewhere])).toEqual([
      `${repository.path}: o standby dos eventos sem a variável`,
      `${elsewhere.path}: usa replicaDatabase fora do feed de eventos`,
      `${elsewhere.path}: replicaDatabase em middleware`,
    ]);
  });

  // The review of wave 17: page 1 of a list from the primary, "load more"
  // on the standby, which has not replayed the cursor's row yet, and
  // Prisma's empty answer ends the list there.
  it("fails a list of the standby that pages with Prisma's cursor on a read chosen per call", () => {
    const repository = at(
      "src/modules/activity/repositories/activity-repository.ts",
    );
    // Line ends as on disk: a Windows checkout has CRLF.
    const text = repository.text.replace(/\r\n/g, "\n");
    const planted = {
      path: repository.path,
      text: text.replace(
        "where: cursor\n        ? { AND: [whereCondition, { id: { lt: cursor } }] }\n        : whereCondition,",
        "where: whereCondition,\n      ...(cursor && { cursor: { id: cursor }, skip: 1 }),",
      ),
    };

    expect(planted.text).not.toBe(text);
    expect(routingProblems([repository])).toEqual([]);
    expect(routingProblems([planted])).toEqual([
      `${repository.path}#listActivitiesWithCursor: pagina com o cursor do Prisma numa leitura escolhida a cada chamada`,
    ]);
  });

  it("keeps Prisma's cursor to an export's own walk, never one over a cursor from outside", () => {
    const repository = at(
      "src/modules/driver/repositories/driver-repository.ts",
    );
    // The export back on `this.read`, chosen again for every batch.
    const perBatch = {
      path: repository.path,
      text: repository.text.replace(
        "await read().driver.findMany({",
        "await this.read.driver.findMany({",
      ),
    };
    const fromOutside = {
      path: "src/modules/sample/repositories/sample-repository.ts",
      text: `class SampleRepository {
  private readWalk() { return readDatabaseWalk(); }
  async listThings({ cursor }: { cursor?: string }) {
    const read = this.readWalk();
    return read().thing.findMany({ ...(cursor && { cursor: { id: cursor }, skip: 1 }) });
  }
}
`,
    };

    expect(perBatch.text).not.toBe(repository.text);
    expect(routingProblems([repository])).toEqual([]);
    expect(routingProblems([perBatch])).toEqual([
      `${repository.path}#streamDriversForExport: pagina com o cursor do Prisma numa leitura escolhida a cada chamada`,
    ]);
    expect(pagingProblems(fromOutside.path, fromOutside.text)).toEqual([
      `${fromOutside.path}#listThings: walk sobre um cursor que veio de fora (pagine pelo valor)`,
    ]);
  });

  it("fails a readDatabaseWalk outside the walk's handle, and an import of it outside the list", () => {
    const repository = at("src/modules/fine/repositories/fine-repository.ts");
    const bypass = {
      path: repository.path,
      text: `${repository.text}\nconst direct = () => readDatabaseWalk()().fine.findMany();\n`,
    };
    const elsewhere = {
      path: "src/modules/middlewares/ensure-api-key.ts",
      text: `import { readDatabaseWalk } from "@/../infra/database";
export const key = () => readDatabaseWalk()();
`,
    };

    expect(routingProblems([bypass, elsewhere])).toEqual([
      `${repository.path}: usa readDatabase fora do getter read`,
      `${elsewhere.path}: usa readDatabase fora da lista fechada`,
      `${elsewhere.path}: readDatabase em middleware`,
    ]);
  });

  it("reads the methods it is meant to find", () => {
    const repository = `
      class Sample {
        constructor(private prisma = database) {}
        private get read() { return this.prisma === database ? readDatabase() : this.prisma; }
        private readWalk() { return this.prisma === database ? readDatabaseWalk() : () => this.prisma; }
        async listThings() { return this.read.thing.findMany(); }
        async *streamThings() { const read = this.readWalk(); yield read().thing.findMany(); }
        async findThing() { return this.prisma.thing.findFirst(); }
      }
    `;

    expect(replicaMethods("sample.ts", repository)).toEqual([
      "listThings",
      "streamThings",
    ]);
    expect(readDatabaseOutsideGetter("sample.ts", repository)).toBe(false);
  });
});
