import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Every path that deletes a row the queues hang off (plano-escala F5-05).
 *
 * notification_delivery, notification_provider_receipt and webhook_delivery
 * hang off user, external_recipient, webhook_endpoint, business and their
 * own events through ON DELETE CASCADE. Wave 10 (F5-06) drops those keys,
 * and from then on whatever a deletion does not take explicitly stays
 * behind. So every deletion of a parent is listed here, with what takes its
 * queue rows: a helper of src/shared/notifications/queue-row-cleanup.ts or
 * the delete of the children in the same statement — or why the rows it
 * leaves are accepted (decision D54: the pipeline closes them as
 * recipient_gone, and the event's purge takes them).
 *
 * A new deletion path fails the first test until somebody decides which
 * one it is. Read from every .ts under src/ by the TypeScript parser: a
 * Prisma delete/deleteMany on a parent model, a nested deleteMany of a
 * queue relation, a raw `DELETE FROM` a parent table, or a parent table
 * handed to the batched delete.
 */
const ROOT = process.cwd();

/** Prisma models whose rows the queues hang off, directly or by cascade. */
const PARENT_MODELS = new Set([
  "user",
  "business",
  "webhookEndpoint",
  "externalRecipient",
  "delivery",
  "domainOutboxEvent",
  "notificationDelivery",
]);

/** The same, as tables. */
const PARENT_TABLES =
  /"(user|business|webhook_endpoint|external_recipient|delivery|domain_outbox_event|notification_delivery)"/;

/** Queue relations a nested write could delete through. */
const QUEUE_RELATIONS = new Set([
  "NotificationDelivery",
  "deliveries",
  "receipts",
  "WebhookDelivery",
  "webhookDeliveries",
]);

interface Deletion {
  /** `<file>#<the method, function or top-level const it is in>`. */
  where: string;
  what: string;
}

/**
 * What takes the queue rows of each path: text its method must contain.
 * `tolerated` instead names why the rows it leaves are accepted.
 */
const PATHS: Record<string, { through: string } | { tolerated: string }> = {
  "src/modules/user/repositories/user-repository.ts#deleteUser": {
    through: "deleteQueueRowsOfUser(",
  },
  "src/modules/user/repositories/user-repository.ts#deleteMasterUserKeepingOne":
    { through: "deleteQueueRowsOfUser(" },
  "src/modules/business/repositories/business-repository.ts#deleteBusiness": {
    through: "deleteQueueRowsOfBusiness(",
  },
  "src/modules/integration/repositories/webhook-endpoint-repository.ts#delete":
    { through: "deleteQueueRowsOfWebhookEndpoint(" },
  // A company's purge (F3-26a) removes the company's row last, for the
  // old "Deletar": every queue row of the company left with the plan's own
  // steps before (purge-plan.ts, tenant-purge-plan and tenant-offboard
  // prove it), and the bell rows of the platform's users about it leave
  // with the bell's retention.
  "src/shared/jobs/tenant-offboard/tenant-offboard-job.ts#finishPurge": {
    tolerated: "F3-26a",
  },
  // Reverting an import deletes its deliveries; their external recipients
  // go by cascade, and the notifications addressed to them, once the keys
  // are gone, close as recipient_gone and leave with the event's purge.
  "src/modules/import/repositories/import-repository.ts#reverseDeliveryBatch": {
    tolerated: "D54",
  },
  // The helpers themselves: each takes the receipts of what it deletes.
  // (endSessionsAndClearInbox drops a user's unsent deliveries through
  // deleteQueueRowsOfUser, so it is no path of its own.)
  "src/shared/notifications/queue-row-cleanup.ts#deleteQueueRowsOfUser": {
    through: '"notification_provider_receipt"',
  },
  "src/shared/notifications/queue-row-cleanup.ts#deleteQueueRowsOfBusiness": {
    through: '"notification_provider_receipt"',
  },
  // The purge: each event batch takes its deliveries, and they their
  // receipts, in the batch's statement (bounded to the legacy partitions
  // once the family is partitioned, F5-11; the days leave by DROP).
  "src/jobs/cron/cleanup-notification-pipeline-job.ts#eventFamilySql": {
    through: '"notification_provider_receipt"',
  },
  "src/jobs/cron/cleanup-notification-pipeline-job.ts#publishedPurgeBatchSql": {
    through: "${eventFamilySql(idBelow)}",
  },
  "src/jobs/cron/cleanup-notification-pipeline-job.ts#failedPurgeBatchSql": {
    through: "${eventFamilySql(idBelow)}",
  },
};

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

/** The method, function or top-level const a node is in, and its text. */
function owner(
  node: ts.Node,
  source: ts.SourceFile,
): { name: string; text: string } {
  for (let current = node.parent; current; current = current.parent) {
    if (
      (ts.isMethodDeclaration(current) || ts.isFunctionDeclaration(current)) &&
      current.name
    ) {
      return {
        name: current.name.getText(source),
        text: current.getText(source),
      };
    }

    if (
      ts.isVariableDeclaration(current) &&
      ts.isVariableStatement(current.parent.parent) &&
      ts.isSourceFile(current.parent.parent.parent)
    ) {
      return {
        name: current.name.getText(source),
        text: current.getText(source),
      };
    }
  }

  return { name: "(top level)", text: source.getFullText() };
}

function templateText(node: ts.Node, source: ts.SourceFile): string | null {
  return ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateExpression(node) ||
    ts.isStringLiteral(node)
    ? node.getText(source)
    : null;
}

/** Every deletion of a parent in one file, with its owner's text. */
function deletionsIn(
  file: string,
  text: string,
): Array<Deletion & { ownerText: string }> {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: Array<Deletion & { ownerText: string }> = [];

  const record = (node: ts.Node, what: string) => {
    const { name, text: ownerText } = owner(node, source);

    found.push({ where: `${file}#${name}`, what, ownerText });
  };

  const visit = (node: ts.Node) => {
    // prisma.<model>.delete(...) / .deleteMany(...)
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ["delete", "deleteMany"].includes(node.expression.name.text) &&
      ts.isPropertyAccessExpression(node.expression.expression) &&
      PARENT_MODELS.has(node.expression.expression.name.text)
    ) {
      record(
        node,
        `${node.expression.expression.name.text}.${node.expression.name.text}`,
      );
    }

    // { NotificationDelivery: { deleteMany: ... } } in a nested write
    if (
      ts.isPropertyAssignment(node) &&
      QUEUE_RELATIONS.has(node.name.getText(source)) &&
      ts.isObjectLiteralExpression(node.initializer) &&
      node.initializer.properties.some((property) =>
        ["delete", "deleteMany"].includes(property.name?.getText(source) ?? ""),
      )
    ) {
      record(node, `nested ${node.name.getText(source)}.deleteMany`);
    }

    // DELETE FROM "<parent>" in raw SQL
    const literal = templateText(node, source);
    const raw = literal?.match(
      new RegExp(`DELETE\\s+FROM\\s+${PARENT_TABLES.source}`, "g"),
    );

    for (const statement of raw ?? []) {
      record(node, statement.replace(/\s+/g, " "));
    }

    // deleteInBatches({ table: Prisma.sql`"<parent>"`, ... })
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(source) === "table" &&
      ts.isTaggedTemplateExpression(node.initializer) &&
      PARENT_TABLES.test(node.initializer.getText(source))
    ) {
      record(node, `batched delete of ${node.initializer.getText(source)}`);
    }

    ts.forEachChild(node, visit);
  };

  visit(source);

  return found;
}

function allDeletions(): Array<Deletion & { ownerText: string }> {
  return filesUnder(resolve(ROOT, "src")).flatMap((path) => {
    const file = relative(ROOT, path).replace(/\\/g, "/");

    return deletionsIn(file, readFileSync(path, "utf8"));
  });
}

describe("the paths that delete a row the queues hang off", () => {
  const deletions = allDeletions();

  it("are exactly the listed ones", () => {
    expect(
      [...new Set(deletions.map((deletion) => deletion.where))].sort(),
    ).toEqual(Object.keys(PATHS).sort());
  });

  it("each take their queue rows in the same method, or say why not", () => {
    for (const deletion of deletions) {
      const path = PATHS[deletion.where];

      if (!path || "tolerated" in path) continue;

      expect(
        deletion.ownerText.includes(path.through),
        `${deletion.where} (${deletion.what}) without ${path.through}`,
      ).toBe(true);
    }
  });

  it("finds a deletion however it is written", () => {
    // Proof the walk sees each shape it looks for.
    const sample = [
      "class R {",
      "  async a() { await this.prisma.user.delete({ where: { id } }); }",
      "  async b() { await tx.business.deleteMany({}); }",
      "  async c() {",
      "    await db.user.update({ data: { NotificationDelivery: { deleteMany: {} } } });",
      "  }",
      "}",
      'const SQL = Prisma.sql`DELETE FROM "domain_outbox_event" WHERE 1 = 1`;',
      "function d() {",
      '  return deleteInBatches({ table: Prisma.sql`"notification_delivery"` });',
      "}",
    ].join("\n");

    expect(
      deletionsIn("sample.ts", sample).map(({ where, what }) => ({
        where,
        what,
      })),
    ).toEqual([
      { where: "sample.ts#a", what: "user.delete" },
      { where: "sample.ts#b", what: "business.deleteMany" },
      { where: "sample.ts#c", what: "nested NotificationDelivery.deleteMany" },
      { where: "sample.ts#SQL", what: 'DELETE FROM "domain_outbox_event"' },
      {
        where: "sample.ts#d",
        what: 'batched delete of Prisma.sql`"notification_delivery"`',
      },
    ]);
  });
});
