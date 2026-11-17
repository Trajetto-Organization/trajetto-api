import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * The delivery trail is append-only for the runtime (plano-escala F3-19).
 *
 * After the cut of the database roles, trajetto_http and trajetto_worker
 * may read delivery_event, append to it and fill in the reverse-geocoded
 * address of a proof (gps_address, gps_address_source, gps_geocoded_at);
 * only trajetto_batch, the maintenance pool, may change or delete a row
 * (infra/sql/20-runtime-roles.sql). A request that tried anything else
 * would fail in production with 42501 — and before the cut, with the
 * superuser, it would quietly rewrite the history support reads.
 *
 * So every write on the trail in src/ is listed here, by the TypeScript
 * parser, and refused unless it is the GPS columns, or a path of the batch
 * pool named in BATCH_WRITERS:
 *
 *  - Prisma: `.deliveryEvent.update/updateMany/updateManyAndReturn/upsert`
 *    whose `data` (an upsert's `update`) names another column, or is not an
 *    object the parser can read; `.delete/deleteMany` always;
 *  - a nested write through a relation to the trail (`events`,
 *    `deliveryEvents`) that updates, upserts, deletes or sets;
 *  - raw SQL: `UPDATE delivery_event` with another column in its SET,
 *    `DELETE FROM delivery_event`, `TRUNCATE delivery_event`;
 *  - a batch purge (`table: Prisma.sql\`"delivery_event"\``).
 *
 * The same for delivery_event_part, the partitioned table the trail moves
 * to later in the plan.
 */
const ROOT = process.cwd();

const GPS_COLUMNS = new Set([
  "gps_address",
  "gps_address_source",
  "gps_geocoded_at",
]);

/**
 * Files whose writes on the trail run on databaseBatch, the trajetto_batch
 * login, with why. Empty today: nothing changes or deletes a row of the
 * trail. A file listed here must use databaseBatch (checked below).
 */
const BATCH_WRITERS: Record<string, string> = {};

const MODEL_UPDATES = new Set(["update", "updateMany", "updateManyAndReturn"]);
const MODEL_DELETES = new Set(["delete", "deleteMany"]);
const TRAIL_RELATIONS = new Set(["events", "deliveryEvents"]);
const NESTED_MUTATIONS = new Set([
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
  "set",
]);

const TRAIL_TABLE = String.raw`(?:"?public"?\.)?"?delivery_event(?:_part)?"?(?![\w])`;

interface Finding {
  file: string;
  line: number;
  what: string;
}

/** The keys of an object literal; null when one of them is not plain. */
function keysOf(node: ts.Expression): string[] | null {
  if (!ts.isObjectLiteralExpression(node)) return null;

  const keys: string[] = [];

  for (const property of node.properties) {
    if (
      (ts.isPropertyAssignment(property) ||
        ts.isShorthandPropertyAssignment(property)) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
    ) {
      keys.push(property.name.text);
    } else {
      return null;
    }
  }

  return keys;
}

function propertyOf(
  node: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | undefined {
  for (const property of node.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      property.name.text === name
    ) {
      return property.initializer;
    }
  }

  return undefined;
}

/** The SQL of a string or template, substitutions as `$1`. */
function sqlOf(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }

  if (ts.isTemplateExpression(node)) {
    return [
      node.head.text,
      ...node.templateSpans.map((span) => `$1${span.literal.text}`),
    ].join("");
  }

  return null;
}

/** What raw SQL does to the trail that the runtime may not. */
function sqlProblems(sql: string): string[] {
  const text = sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
  const problems: string[] = [];

  for (const match of text.matchAll(
    new RegExp(
      String.raw`\bUPDATE\s+(?:ONLY\s+)?${TRAIL_TABLE}(?:\s+(?:AS\s+)?\w+)?\s+SET\s+([\s\S]*?)(?=\bWHERE\b|\bFROM\b|\bRETURNING\b|;|$)`,
      "gi",
    ),
  )) {
    const columns = [
      ...match[1].matchAll(/(?:^|,)\s*(?:\w+\.)?"?(\w+)"?\s*=/g),
    ].map((column) => column[1]);
    const others = columns.filter((column) => !GPS_COLUMNS.has(column));

    if (columns.length === 0 || others.length > 0) {
      problems.push(`UPDATE de ${others.join(", ") || "colunas ilegíveis"}`);
    }
  }

  if (
    new RegExp(
      String.raw`\bDELETE\s+FROM\s+(?:ONLY\s+)?${TRAIL_TABLE}`,
      "i",
    ).test(text)
  ) {
    problems.push("DELETE");
  }

  if (
    new RegExp(
      String.raw`\bTRUNCATE\s+(?:TABLE\s+)?(?:ONLY\s+)?${TRAIL_TABLE}`,
      "i",
    ).test(text)
  ) {
    problems.push("TRUNCATE");
  }

  return problems;
}

function scan(file: string, text: string): Finding[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const findings: Finding[] = [];
  const lineOf = (node: ts.Node) =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const report = (node: ts.Node, what: string) =>
    findings.push({ file, line: lineOf(node), what });

  const visit = (node: ts.Node): void => {
    // Prisma's model API: <client>.deliveryEvent.<method>(args).
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isPropertyAccessExpression(node.expression.expression) &&
      node.expression.expression.name.text === "deliveryEvent"
    ) {
      const method = node.expression.name.text;
      const [args] = node.arguments;

      if (MODEL_DELETES.has(method)) {
        report(node, `deliveryEvent.${method}`);
      } else if (MODEL_UPDATES.has(method) || method === "upsert") {
        const data =
          args && ts.isObjectLiteralExpression(args)
            ? propertyOf(args, method === "upsert" ? "update" : "data")
            : undefined;
        const keys = data ? keysOf(data) : null;
        const others = (keys ?? []).filter((key) => !GPS_COLUMNS.has(key));

        if (keys === null) {
          report(node, `deliveryEvent.${method} com dados ilegíveis`);
        } else if (others.length > 0) {
          report(node, `deliveryEvent.${method} de ${others.join(", ")}`);
        }
      }
    }

    // A nested write through a relation to the trail.
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      TRAIL_RELATIONS.has(node.name.text) &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const key of keysOf(node.initializer) ?? []) {
        if (NESTED_MUTATIONS.has(key)) {
          report(node, `${node.name.text}.${key} aninhado`);
        }
      }
    }

    // A batch purge of the trail: deleteInBatches({ table: … }).
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "table" &&
      new RegExp(TRAIL_TABLE).test(node.initializer.getText(source))
    ) {
      report(node, "expurgo em lote");
    }

    const sql = sqlOf(node);

    if (sql !== null) {
      for (const problem of sqlProblems(sql)) report(node, problem);
    }

    ts.forEachChild(node, visit);
  };

  visit(source);

  return findings;
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);

    return statSync(path).isDirectory()
      ? filesUnder(path)
      : path.endsWith(".ts")
        ? [path]
        : [];
  });
}

const sources = () =>
  filesUnder(resolve(ROOT, "src")).map((path) => ({
    file: relative(ROOT, path).replace(/\\/g, "/"),
    text: readFileSync(path, "utf8"),
  }));

describe("writes on the delivery trail in src/", () => {
  it("are only the GPS address, outside the batch pool's paths", () => {
    const findings = sources()
      .filter(({ file }) => !(file in BATCH_WRITERS))
      .flatMap(({ file, text }) => scan(file, text));

    expect(findings).toEqual([]);
  });

  it("see the one write the runtime does: the proof's GPS address", () => {
    // Proof the scan reads the real call, not an empty tree: the same
    // file with the update widened to another column is refused.
    const file =
      "src/modules/delivery/repositories/proof-document-repository.ts";
    const text = readFileSync(resolve(ROOT, file), "utf8");

    expect(text).toContain("this.prisma.deliveryEvent.updateMany(");
    expect(text).toContain("gps_geocoded_at: cache.gps_geocoded_at");
    expect(scan(file, text)).toEqual([]);
    expect(
      scan(
        file,
        text.replace(
          "gps_geocoded_at: cache.gps_geocoded_at",
          "received_by: cache.gps_geocoded_at",
        ),
      ),
    ).toEqual([
      expect.objectContaining({
        what: "deliveryEvent.updateMany de received_by",
      }),
    ]);
  });

  it("name only files that write through the batch pool", () => {
    for (const file of Object.keys(BATCH_WRITERS)) {
      expect(readFileSync(resolve(ROOT, file), "utf8"), file).toContain(
        "databaseBatch",
      );
    }
  });
});

describe("the scan, on planted code", () => {
  const planted = (code: string) =>
    scan("planted.ts", code).map((finding) => finding.what);

  it.each([
    [
      "a model update of the event type",
      `await tx.deliveryEvent.update({ where: { id }, data: { type: "NOTE" } });`,
      ["deliveryEvent.update de type"],
    ],
    [
      "an update built elsewhere",
      `await prisma.deliveryEvent.updateMany({ where, data });`,
      ["deliveryEvent.updateMany com dados ilegíveis"],
    ],
    [
      "a spread into the data",
      `await prisma.deliveryEvent.updateMany({ where, data: { ...patch } });`,
      ["deliveryEvent.updateMany com dados ilegíveis"],
    ],
    [
      "an upsert's update",
      `await prisma.deliveryEvent.upsert({ where, create, update: { note: "x" } });`,
      ["deliveryEvent.upsert de note"],
    ],
    [
      "a model delete",
      `await this.prisma.deliveryEvent.deleteMany({ where: { deliveryId } });`,
      ["deliveryEvent.deleteMany"],
    ],
    [
      "a nested update through the delivery",
      `await prisma.delivery.update({ where, data: { events: { updateMany: { where: {}, data: { note: "" } } } } });`,
      ["events.updateMany aninhado"],
    ],
    [
      "a raw update of another column",
      'await tx.$executeRaw`UPDATE "delivery_event" SET "note" = ${note} WHERE id = ${id}`;',
      ["UPDATE de note"],
    ],
    [
      "a raw update of the partitioned trail, with an alias",
      `await tx.$executeRawUnsafe('UPDATE public.delivery_event_part AS e SET "routeId" = NULL WHERE e.id = $1', id);`,
      ["UPDATE de routeId"],
    ],
    [
      "a raw delete",
      'await tx.$executeRaw`DELETE FROM delivery_event WHERE "deliveryId" = ${id}`;',
      ["DELETE"],
    ],
    [
      "a truncate",
      `await prisma.$executeRawUnsafe("TRUNCATE TABLE delivery_event");`,
      ["TRUNCATE"],
    ],
    [
      "a batch purge",
      'await deleteInBatches({ table: Prisma.sql`"delivery_event"`, where, maxRows: 1000 });',
      ["expurgo em lote"],
    ],
  ])("refuse %s", (_case, code, expected) => {
    expect(planted(code)).toEqual(expected);
  });

  it.each([
    [
      "the GPS address, in Prisma",
      `await this.prisma.deliveryEvent.updateMany({ where, data: { gps_address: x, gps_address_source: y, gps_geocoded_at: z } });`,
    ],
    [
      "the GPS address, in raw SQL",
      'await tx.$executeRaw`UPDATE "delivery_event" SET "gps_geocoded_at" = now(), gps_address_source = ${s} WHERE id = ${id}`;',
    ],
    [
      "an insert and a read",
      'await tx.deliveryEvent.create({ data }); await tx.$queryRaw`SELECT * FROM "delivery_event" WHERE id = ${id}`;',
    ],
    [
      "a nested create through the delivery",
      `await prisma.delivery.update({ where, data: { events: { create: { type: "NOTE" } } } });`,
    ],
    [
      "another table's update",
      'await tx.$executeRaw`UPDATE "delivery_event_reason" SET note = 1`;',
    ],
  ])("let %s through", (_case, code) => {
    expect(planted(code)).toEqual([]);
  });
});
