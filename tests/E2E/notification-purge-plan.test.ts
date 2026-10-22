import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Prisma, PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { publishedPurgeBatchSql } from "@/jobs/cron/cleanup-notification-pipeline-job";

/**
 * What one night of the notification purge costs at the target scale
 * (OUTBOX-18, reviewer's follow-up).
 *
 * The dead-letter archive used to be a separate walk before the purge: its
 * last statement read EVERY retained FAILED delivery through the failed index,
 * one heap fetch and one event lookup each, to find the few whose event was
 * due. With millions of failures that statement passes the 30 s
 * statement_timeout production applies to the cron too, the handler throws
 * before the purge, and PUBLISHED events stop being deleted every night. The
 * purge itself had no index on (status, processedAt): its last batch was a
 * sequential scan of domain_outbox_event.
 *
 * Now each batch is one statement: take the next due PUBLISHED events through
 * a partial index on processedAt, copy THEIR failed deliveries (by
 * outboxEventId) and delete them. The cost follows what is purged, not what
 * is kept. Same conditions as the other plan tests: sequential scans off and a
 * generic plan, so a Seq Scan here means "no index applies".
 */
const prisma = new PrismaClient();

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Index Cond"?: string;
  "Recheck Cond"?: string;
  Plans?: PlanNode[];
}

function flatten(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flatten)];
}

function literal(value: unknown): string {
  if (value instanceof Date) return `'${value.toISOString()}'`;
  if (typeof value === "number") return String(value);

  return `'${String(value).replace(/'/g, "''")}'`;
}

async function genericPlan(query: Prisma.Sql): Promise<PlanNode> {
  const name = `purge_plan_${randomUUID().replace(/-/g, "")}`;

  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
    await tx.$executeRawUnsafe(
      "SET LOCAL plan_cache_mode = force_generic_plan",
    );
    await tx.$executeRawUnsafe(`PREPARE ${name} AS ${query.text}`);

    const args = query.values.length
      ? `(${query.values.map(literal).join(", ")})`
      : "";

    const [row] = await tx.$queryRawUnsafe<Array<{ "QUERY PLAN": unknown }>>(
      `EXPLAIN (FORMAT JSON) EXECUTE ${name}${args}`,
    );

    await tx.$executeRawUnsafe(`DEALLOCATE ${name}`);

    return (row["QUERY PLAN"] as Array<{ Plan: PlanNode }>)[0].Plan;
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The reviewer's scenario, scaled down: many failures retained under events
 * that are NOT due yet, a few due events, and real statistics. On an empty
 * table every plan costs nothing and proves nothing.
 */
const RETAINED_EVENTS = 4_000;
const DUE_EVENTS = 200;

beforeAll(async () => {
  const user = await prisma.user.create({
    data: {
      name: "Destinatária do Expurgo",
      email: `purge-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "MASTER",
    },
  });

  const event = (processedDaysAgo: number) => ({
    id: randomUUID(),
    eventKey: `purge-${randomUUID()}`,
    topic: "delivery.dispatched",
    aggregateType: "delivery",
    aggregateId: randomUUID(),
    payload: {},
    status: "PUBLISHED" as const,
    processedAt: new Date(Date.now() - processedDaysAgo * DAY_MS),
  });

  const retained = Array.from({ length: RETAINED_EVENTS }, () => event(2));
  const due = Array.from({ length: DUE_EVENTS }, () => event(40));

  await prisma.domainOutboxEvent.createMany({ data: [...due, ...retained] });

  await prisma.notificationDelivery.createMany({
    data: [...due, ...retained].flatMap((row) => [
      {
        outboxEventId: row.id,
        userId: user.id,
        channel: "EMAIL" as const,
        status: "FAILED" as const,
        attempts: 5,
        lastError: "550 recusado",
      },
      {
        outboxEventId: row.id,
        userId: user.id,
        channel: "IN_APP" as const,
        status: "DELIVERED" as const,
      },
    ]),
  });

  await prisma.$executeRawUnsafe(
    `ANALYZE "domain_outbox_event", "notification_delivery"`,
  );
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("one batch of the nightly purge", () => {
  const statement = () =>
    publishedPurgeBatchSql(
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      5_000,
    );

  it("takes the due events through the partial index, never a scan", async () => {
    const nodes = flatten(await genericPlan(statement()));

    expect(
      nodes.filter(
        (node) =>
          node["Node Type"] === "Seq Scan" &&
          node["Relation Name"] === "domain_outbox_event",
      ),
    ).toEqual([]);

    expect(nodes.map((node) => node["Index Name"])).toContain(
      "domain_outbox_event_published_processed_idx",
    );
  });

  it("reads the failed deliveries of THOSE events, not every retained failure", async () => {
    const deliveryReads = flatten(await genericPlan(statement())).filter(
      (node) => node["Relation Name"] === "notification_delivery",
    );

    expect(deliveryReads.length).toBeGreaterThan(0);

    // Every read of the table is a lookup keyed by the event being purged:
    // an index scan with the key in its Index Cond, or a bitmap heap scan
    // with it in the Recheck Cond (its bitmap index child carries the same).
    for (const node of deliveryReads) {
      expect(node["Node Type"]).not.toBe("Seq Scan");
      expect(node["Index Name"]).not.toBe("notification_delivery_failed_idx");
      expect(node["Index Cond"] ?? node["Recheck Cond"] ?? "").toContain(
        "outboxEventId",
      );
    }
  });
});
