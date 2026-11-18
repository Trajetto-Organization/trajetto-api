import { v7 as uuidV7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "@/shared/database/database-client";
import { PROCESS_CAPABILITIES } from "@/shared/health/capabilities";
import {
  historyIdRange,
  historyIdRangeSince,
} from "@/shared/time/history-id-range";

import { seedFleetDriver } from "./support/fleet-driver-seed";
import { runHistoryWindow, unpartitionHistory } from "./support/history-window";

/**
 * The hot reads of the history once it is partitioned by month on its id
 * (plano-escala F2-17): at most two partitions each.
 *
 * After the copy window, delivery_event is a parent with a partition for
 * everything before its first month and one a month ahead of it. A read
 * that names only a delivery, or only a day's created_at, plans and scans
 * every one of them; the repositories add the id bounds of
 * src/shared/time/history-id-range.ts (the delivery's timeline from its own
 * id to now, the tower's day with two days of margin), and the planner
 * keeps the months the answer is in. Checked on the plan of the same
 * predicates the repositories send, with the values bound, as the first
 * executions plan them.
 */
const prisma = createPrismaClient();

let businessId: string;
let deliveryId: string;

interface PlanNode {
  "Relation Name"?: string;
  Plans?: PlanNode[];
}

/** The partitions of delivery_event a statement's plan reads. */
async function partitionsRead(sql: string, ...values: unknown[]) {
  const [row] = await prisma.$queryRawUnsafe<
    Array<{ "QUERY PLAN": Array<{ Plan: PlanNode }> }>
  >(`EXPLAIN (FORMAT JSON) ${sql}`, ...values);

  const found = new Set<string>();
  const walk = (node: PlanNode) => {
    if (node["Relation Name"]?.startsWith("delivery_event_")) {
      found.add(node["Relation Name"]);
    }

    node.Plans?.forEach(walk);
  };

  walk(row["QUERY PLAN"][0].Plan);

  return [...found].sort();
}

beforeAll(async () => {
  const seed = await seedFleetDriver(prisma, {
    businessId: "019a9a30-0000-7000-8000-00000000000a",
    cnpj: "55777760000191",
  });

  businessId = seed.businessId;

  const shipper = await prisma.shipper.create({
    data: { name: "Embarcador", businessId },
  });

  deliveryId = (
    await prisma.delivery.create({
      data: {
        recipient_name: "Mercado Central",
        city: "São Paulo",
        uf: "SP",
        street: "Rua das Entregas",
        businessId,
        shipperId: shipper.id,
      },
      select: { id: true },
    })
  ).id;

  // A year of history in the partition before the first month, today's
  // events in this month's.
  await prisma.$executeRaw`
    INSERT INTO "delivery_event" ("id", "type", "note", "deliveryId", "businessId", "created_at")
    SELECT ${uuidV7({ msecs: Date.parse("2025-06-01T12:00:00Z") })}, 'NOTE', 'antigo', ${deliveryId}, ${businessId}, '2025-06-01 12:00'
  `;

  for (const note of ["um", "dois"]) {
    await prisma.deliveryEvent.create({
      data: { type: "NOTE", note, deliveryId, businessId },
    });
  }

  await prisma.opsSample.create({
    data: {
      ts: new Date(),
      role: "all",
      replica: "api-history-plans",
      commit: null,
      metrics: { v: 1, capabilities: [...PROCESS_CAPABILITIES] },
    },
  });

  const window = await runHistoryWindow("30-delivery-event-window.sql");

  expect(window.status, window.detail).toBe("applied");

  await prisma.$executeRawUnsafe(`ANALYZE "delivery_event"`);
}, 120_000);

afterAll(async () => {
  await unpartitionHistory("delivery_event", { hold: false });
  await prisma.$disconnect();
});

describe("the delivery's timeline", () => {
  it("reads at most two months, where without the bound it reads them all", async () => {
    const range = historyIdRangeSince(deliveryId)!;
    const timeline = `SELECT "id" FROM "delivery_event" WHERE "deliveryId" = $1 AND "id" >= $2 AND "id" < $3 ORDER BY "created_at" DESC`;

    const bounded = await partitionsRead(
      timeline,
      deliveryId,
      range.gte,
      range.lt,
    );

    expect(bounded.length, bounded.join(", ")).toBeGreaterThanOrEqual(1);
    expect(bounded.length, bounded.join(", ")).toBeLessThanOrEqual(2);

    const unbounded = await partitionsRead(
      `SELECT "id" FROM "delivery_event" WHERE "deliveryId" = $1 ORDER BY "created_at" DESC`,
      deliveryId,
    );

    // The partition before the first month and every month made ahead.
    expect(unbounded.length).toBeGreaterThanOrEqual(4);
  });
});

describe("the tower's day", () => {
  it("reads at most two months for the day's feed", async () => {
    const now = new Date();
    const start = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    const range = historyIdRange(start, end);

    const read = await partitionsRead(
      `SELECT "id" FROM "delivery_event"
        WHERE "businessId" = $1 AND "id" >= $2 AND "id" < $3
          AND "created_at" >= $4 AND "created_at" < $5
        ORDER BY "created_at" DESC, "id" DESC LIMIT 50`,
      businessId,
      range.gte,
      range.lt,
      start,
      end,
    );

    expect(read.length, read.join(", ")).toBeGreaterThanOrEqual(1);
    expect(read.length, read.join(", ")).toBeLessThanOrEqual(2);
  });
});
