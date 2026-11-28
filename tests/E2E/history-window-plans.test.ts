import { v7 as uuidV7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "@/shared/database/database-client";
import { PROCESS_CAPABILITIES } from "@/shared/health/capabilities";
import {
  historyIdRange,
  historyIdRangeSince,
} from "@/shared/time/history-id-range";
import { activityIdRange } from "@/shared/activity/activity-period";
import { businessDaysRange } from "@/shared/time/business-day";

import { seedFleetDriver } from "./support/fleet-driver-seed";
import { runHistoryWindow, unpartitionHistory } from "./support/history-window";

/**
 * The hot reads of the history once it is partitioned by month on its id
 * (plano-escala F2-17, F2-19): at most two partitions each.
 *
 * After the copy window, delivery_event is a parent with a partition for
 * everything before its first month and one a month ahead of it. A read
 * that names only a delivery, or only a day's created_at, plans and scans
 * every one of them; the repositories add the id bounds of
 * src/shared/time/history-id-range.ts (the delivery's timeline from its own
 * id to now, the tower's day with two days of margin), and the planner
 * keeps the months the answer is in. The activity listings do the same
 * with their period (src/shared/activity/activity-period.ts, 30 days on the
 * web's table by default). Checked on the plan of the same predicates the
 * repositories send, with the values bound, as the first executions plan
 * them.
 */
const prisma = createPrismaClient();

let businessId: string;
let deliveryId: string;

interface PlanNode {
  "Relation Name"?: string;
  Plans?: PlanNode[];
}

/** The partitions of `table` a statement's plan reads. */
async function partitionsOf(
  table: string,
  sql: string,
  ...values: unknown[]
): Promise<string[]> {
  const [row] = await prisma.$queryRawUnsafe<
    Array<{ "QUERY PLAN": Array<{ Plan: PlanNode }> }>
  >(`EXPLAIN (FORMAT JSON) ${sql}`, ...values);

  const found = new Set<string>();
  const walk = (node: PlanNode) => {
    if (node["Relation Name"]?.startsWith(`${table}_`)) {
      found.add(node["Relation Name"]);
    }

    node.Plans?.forEach(walk);
  };

  walk(row["QUERY PLAN"][0].Plan);

  return [...found].sort();
}

/** The partitions of delivery_event a statement's plan reads. */
const partitionsRead = (sql: string, ...values: unknown[]) =>
  partitionsOf("delivery_event", sql, ...values);

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

  // The activity trail: rows of last year and of today.
  await prisma.$executeRaw`
    INSERT INTO "activity" ("id", "type", "action", "entityId", "description", "status", "businessId", "created_at", "updated_at")
    VALUES (gen_random_uuid()::text, 'vehicle', 'create', 'v1', 'antiga', 'Criado', ${businessId}, '2025-03-10 14:30', '2025-03-10 14:30')
  `;
  await prisma.activity.createMany({
    data: [1, 2, 3].map((n) => ({
      type: "vehicle",
      action: "update",
      entityId: `v${n}`,
      description: `nova ${n}`,
      status: "Atualizado",
      businessId,
    })),
  });

  for (const step of [
    "30-delivery-event-window.sql",
    "31-activity-window.sql",
  ] as const) {
    const window = await runHistoryWindow(step);

    expect(window.status, window.detail).toBe("applied");
  }

  await prisma.$executeRawUnsafe(`ANALYZE "delivery_event"`);
  await prisma.$executeRawUnsafe(`ANALYZE "activity"`);
}, 120_000);

afterAll(async () => {
  await unpartitionHistory("delivery_event", { hold: false });
  await unpartitionHistory("activity", { hold: false });
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

describe("the activity listings with a period", () => {
  it("read at most two months for 7 and 30 days, where without the ids they read them all", async () => {
    for (const days of [7, 30]) {
      const { start } = businessDaysRange(
        new Date(),
        "America/Sao_Paulo",
        days,
      );
      const ids = activityIdRange(start)!;

      const read = await partitionsOf(
        "activity",
        `SELECT "id" FROM "activity"
          WHERE "businessId" = $1 AND "created_at" >= $2 AND "id" >= $3 AND "id" < $4
          ORDER BY "created_at" DESC, "id" DESC LIMIT 10`,
        businessId,
        start,
        ids.gte,
        ids.lt,
      );

      expect(
        read.length,
        `${days}d: ${read.join(", ")}`,
      ).toBeGreaterThanOrEqual(1);
      expect(read.length, `${days}d: ${read.join(", ")}`).toBeLessThanOrEqual(
        2,
      );
    }

    const unbounded = await partitionsOf(
      "activity",
      `SELECT "id" FROM "activity" WHERE "businessId" = $1 AND "created_at" >= $2
        ORDER BY "created_at" DESC, "id" DESC LIMIT 10`,
      businessId,
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    );

    expect(unbounded.length).toBeGreaterThanOrEqual(4);
  });
});
