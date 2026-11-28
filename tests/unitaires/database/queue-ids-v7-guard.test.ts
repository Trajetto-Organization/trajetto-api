import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { deliveryIdFor } from "@/shared/notifications/delivery-id";
import { receiptIdFor } from "@/shared/notifications/receipt-id";

/**
 * Every id written into the four queues is a uuid v7 (plano-escala F5-07).
 *
 * From the swap of F5-09 on, domain_outbox_event, notification_delivery,
 * notification_provider_receipt and webhook_delivery are partitioned by day
 * on RANGE(id): a uuid v7 starts with its millisecond, so a row lands in
 * the day it belongs to and a day is dropped whole (F5-11). A v4 id is
 * random from its first digit: it lands in any day's range, years away or
 * in a partition already dropped, and the INSERT fails or the row goes with
 * the wrong day. Nothing in Postgres would say why.
 *
 * So, read from the code with the TypeScript parser:
 *
 *  - each of the four models mints its own id as a v7 when none is given
 *    (`@default(uuid(7))` in prisma/schema.prisma);
 *  - every write into them in src/ (create, createMany,
 *    createManyAndReturn, upsert, and the raw INSERTs) is in WRITERS, with
 *    how its ids are made: a new path fails here until somebody looks;
 *  - an `id` such a write gives explicitly comes from a v7 maker (uuidv7,
 *    deliveryIdFor, receiptIdFor), directly or through a const of the same
 *    file;
 *  - and no v4 maker (randomUUID, uuidv4, gen_random_uuid…) appears in a
 *    writer's file except where V4_NOT_IDS says it is not an id.
 *
 * The planted cases at the end prove the checker refuses a v4 id.
 */
const ROOT = process.cwd();

const QUEUE_MODELS = [
  "domainOutboxEvent",
  "notificationDelivery",
  "notificationProviderReceipt",
  "webhookDelivery",
] as const;

const QUEUE_TABLES = [
  "domain_outbox_event",
  "notification_delivery",
  "notification_provider_receipt",
  "webhook_delivery",
] as const;

const CREATES = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "upsert",
]);

/** The calls whose result is a uuid v7. */
const V7_MAKERS = new Set([
  "uuidv7",
  "uuidV7",
  "v7",
  "deliveryIdFor",
  "receiptIdFor",
]);

/** What a v4 looks like in TypeScript and in SQL. */
const V4_MAKER =
  /\b(?:randomUUID|uuidv4|uuidV4|v4|gen_random_uuid|uuid_generate_v4)\s*\(/g;

/**
 * Every file that writes into a queue, how many writes it has, and where
 * their ids come from.
 */
const WRITERS: Record<string, { writes: number; ids: string }> = {
  "src/shared/notifications/outbox-service.ts": {
    writes: 4,
    ids: "uuidv7() for the event, given before the key row points at it; the raw INSERT of a merged event takes the same const",
  },
  "src/shared/notifications/outbox-dead-letter.ts": {
    writes: 2,
    ids: "uuidv7() for the replayed event; deliveryIdFor for the deliveries it gives back",
  },
  "src/shared/notifications/notification-pipeline-service.ts": {
    writes: 1,
    ids: "deliveryIdFor (F5-03): the event's millisecond and the recipient",
  },
  "src/shared/notifications/provider-receipts.ts": {
    writes: 2,
    ids: "receiptIdFor (F5-04), set where each fact is built",
  },
  "src/shared/integration/webhook-dispatch-service.ts": {
    writes: 3,
    ids: "none given: the model's @default(uuid(7))",
  },
  "src/modules/integration/repositories/webhook-delivery-repository.ts": {
    writes: 1,
    ids: "none given: buildResendRow copies no id, the model's default mints one",
  },
};

/** v4 makers in a writer's file that do not make an id, with why. */
const V4_NOT_IDS: Record<string, Array<{ line: RegExp; why: string }>> = {
  "src/shared/notifications/outbox-service.ts": [
    {
      line: /^import \{ v4 as uuidv4, v7 as uuidv7 \} from "uuid";$/,
      why: "the import",
    },
    {
      line: /input\.eventKey \?\? `\$\{input\.topic\}:\$\{input\.aggregateId\}:\$\{uuidv4\(\)\}`/,
      why: "the random suffix of an eventKey nobody asked for, never an id",
    },
  ],
  "src/shared/notifications/outbox-dead-letter.ts": [
    {
      line: /^import \{ v4 as uuidv4, v7 as uuidv7 \} from "uuid";$/,
      why: "the import",
    },
    {
      line: /eventKey: `\$\{copy\.topic\}:\$\{copy\.aggregateId\}:\$\{uuidv4\(\)\}`/,
      why: "the replay's fresh eventKey, never an id",
    },
  ],
};

function sourceFiles(dir: string): string[] {
  return readdirSync(resolve(ROOT, dir)).flatMap((name) => {
    const path = join(dir, name);

    if (statSync(resolve(ROOT, path)).isDirectory()) {
      return name === "in-memory" ? [] : sourceFiles(path);
    }

    return name.endsWith(".ts") ? [path.replace(/\\/g, "/")] : [];
  });
}

interface Scan {
  writes: number;
  problems: string[];
}

/** The v7 makers a const of the file is initialized with, by name. */
function constInitializers(
  source: ts.SourceFile,
): Map<string, ts.Expression[]> {
  const found = new Map<string, ts.Expression[]>();

  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      const list = found.get(node.name.text) ?? [];

      list.push(node.initializer);
      found.set(node.name.text, list);
    }

    ts.forEachChild(node, visit);
  };

  visit(source);

  return found;
}

function isV7Call(expression: ts.Expression): boolean {
  if (!ts.isCallExpression(expression)) return false;

  const callee = expression.expression;
  const name = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : null;

  return name !== null && V7_MAKERS.has(name);
}

/** Whether an `id` value is a v7: a maker's call, or a const set to one. */
function isV7(
  expression: ts.Expression,
  consts: Map<string, ts.Expression[]>,
): boolean {
  if (isV7Call(expression)) return true;

  if (ts.isIdentifier(expression)) {
    const initializers = consts.get(expression.text) ?? [];

    return (
      initializers.length > 0 &&
      initializers.every((initializer) => isV7Call(initializer))
    );
  }

  return false;
}

/** The writes into the queues of one file, and what is wrong with them. */
function scanFile(file: string, text: string): Scan {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const consts = constInitializers(source);
  const problems: string[] = [];
  let writes = 0;

  const checkIds = (node: ts.Node, where: string) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === "id") {
      if (!isV7(node.initializer, consts)) {
        problems.push(
          `${where}: id que não é v7 (${node.initializer.getText(source)})`,
        );
      }
    }

    if (ts.isShorthandPropertyAssignment(node) && node.name.text === "id") {
      if (!isV7(node.name, consts)) {
        problems.push(`${where}: id que não é v7 (id)`);
      }
    }

    ts.forEachChild(node, (child) => checkIds(child, where));
  };

  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isPropertyAccessExpression(node.expression.expression) &&
      (QUEUE_MODELS as readonly string[]).includes(
        node.expression.expression.name.text,
      ) &&
      CREATES.has(node.expression.name.text)
    ) {
      writes += 1;

      const line =
        source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

      // The rows' ids: under `data` (and an upsert's `create`), never the
      // `select` or the `where`.
      for (const argument of node.arguments) {
        if (!ts.isObjectLiteralExpression(argument)) continue;

        for (const property of argument.properties) {
          if (
            ts.isPropertyAssignment(property) &&
            ["data", "create"].includes(property.name.getText(source))
          ) {
            checkIds(property.initializer, `${file}:${line}`);
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(source);

  for (const table of QUEUE_TABLES) {
    writes += text.split(`INSERT INTO "${table}"`).length - 1;
  }

  const allowed = V4_NOT_IDS[file] ?? [];

  text.split(/\r?\n/).forEach((line, index) => {
    if (!new RegExp(V4_MAKER.source).test(line)) return;

    if (!allowed.some((entry) => entry.line.test(line.trim()))) {
      problems.push(
        `${file}:${index + 1}: gerador de uuid v4 num arquivo que grava nas filas: ${line.trim()}`,
      );
    }
  });

  return { writes, problems };
}

describe("the ids of the four queues", () => {
  it("default to a uuid v7 in the schema", () => {
    const schema = readFileSync(resolve(ROOT, "prisma/schema.prisma"), "utf8");

    for (const model of [
      "DomainOutboxEvent",
      "NotificationDelivery",
      "NotificationProviderReceipt",
      "WebhookDelivery",
    ]) {
      const body = schema.slice(schema.indexOf(`model ${model} {`));

      expect(body, model).toMatch(
        /^\s*id\s+String\s+@id\s+@default\(uuid\(7\)\)/m,
      );
    }
  });

  it("are written only by the files listed, each write accounted for", () => {
    const found: Record<string, number> = {};

    for (const file of sourceFiles("src")) {
      const { writes } = scanFile(
        file,
        readFileSync(resolve(ROOT, file), "utf8"),
      );

      if (writes > 0)
        found[relative(ROOT, resolve(ROOT, file)).replace(/\\/g, "/")] = writes;
    }

    expect(found).toEqual(
      Object.fromEntries(
        Object.entries(WRITERS).map(([file, { writes }]) => [file, writes]),
      ),
    );
  });

  it("are v7 in every write, and no v4 maker feeds them", () => {
    const problems = Object.keys(WRITERS).flatMap(
      (file) =>
        scanFile(file, readFileSync(resolve(ROOT, file), "utf8")).problems,
    );

    expect(problems).toEqual([]);
  });

  it("come out of the deterministic makers as v7", () => {
    const delivery = deliveryIdFor(
      { id: "018f5e00-0000-7000-8000-000000000001", created_at: new Date() },
      {
        userId: "018f5e00-0000-7000-8000-000000000002",
        externalRecipientId: null,
      },
      "EMAIL",
    );
    const receipt = receiptIdFor({
      deliveryId: delivery,
      provider: "expo",
      providerMessageId: "ticket-1",
      status: "ticket",
      occurredAt: new Date(),
    });

    for (const id of [delivery, receipt]) {
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
  });
});

describe("the guard, on planted code", () => {
  const FILE = "src/shared/notifications/outbox-service.ts";

  it("refuses a v4 id given to a queue", () => {
    const planted = `
      import { randomUUID } from "node:crypto";
      await database.notificationDelivery.createMany({
        data: rows.map((row) => ({ ...row, id: randomUUID() })),
      });
    `;
    const scan = scanFile("src/planted.ts", planted);

    expect(scan.writes).toBe(1);
    expect(scan.problems.join("\n")).toMatch(
      /id que não é v7 \(randomUUID\(\)\)/,
    );
    expect(scan.problems.join("\n")).toMatch(/gerador de uuid v4/);
  });

  it("refuses a const made by a v4 maker, even beside a v7 one", () => {
    const planted = `
      import { v4 as uuidv4, v7 as uuidv7 } from "uuid";
      const id = uuidv4();
      await tx.webhookDelivery.create({ data: { id, topic } });
    `;

    expect(scanFile(FILE, planted).problems.join("\n")).toMatch(
      /id que não é v7 \(id\)/,
    );
  });

  it("accepts the v7 makers, directly and through a const", () => {
    const planted = `
      const id = uuidv7();
      await tx.domainOutboxEvent.create({ data: { ...row, id } });
      await tx.notificationDelivery.createMany({
        data: rows.map((row) => ({ id: deliveryIdFor(event, row, row.channel) })),
      });
    `;
    const scan = scanFile("src/planted.ts", planted);

    expect(scan.writes).toBe(2);
    expect(scan.problems).toEqual([]);
  });

  it("counts a raw INSERT into a queue as a write", () => {
    expect(
      scanFile(
        "src/planted.ts",
        'tx.$queryRaw`INSERT INTO "webhook_delivery" ("id") VALUES (${x})`',
      ).writes,
    ).toBe(1);
  });
});
