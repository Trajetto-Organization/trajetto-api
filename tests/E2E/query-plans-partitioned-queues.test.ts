import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import type pg from "pg";

import { openReleaseClient } from "infra/scripts/release-connection";

import { publishedPurgeBatchSql } from "@/jobs/cron/cleanup-notification-pipeline-job";
import { createPrismaClient } from "@/shared/database/database-client";
import {
  createClaimFloors,
  type ClaimFloorQueue,
} from "@/shared/database/queue-claim-floor";
import { webhookClaimSql } from "@/shared/integration/webhook-dispatch-service";
import {
  deliveryClaimSql,
  outboxClaimSql,
} from "@/shared/notifications/notification-pipeline-service";
import {
  deliveriesInWindowSql,
  queueTableStatsSql,
} from "@/shared/health/metrics-queries";
import { uuid7Floor } from "@/shared/time/uuid7-floor";

import { withParentNames } from "./support/partition-plan";
import { swapCutoff } from "./support/queue-partitions";
import { uuid7Sql } from "./support/uuid7-sql";

/**
 * The partitioned queues' hot statements with a month of days attached
 * (plano-escala F5-13): 32 days behind and 7 ahead, 39 partitions per
 * queue, the most the 30-day retention keeps.
 *
 * A statement without the id in its filter reads every partition: a claim
 * is one index probe per partition, and its plan names every one of them.
 * Thirty-nine probes of a partial index that holds a handful of entries
 * cost little, but the planning grows with the partitions, and a claim
 * runs several times a second on every replica. The gate, per statement:
 * an index on every partition that holds rows (no sequential scan), fewer
 * than 300 buffers, and a planning p95 under 2 ms. Past it, the plan B is
 * a floor of ids in flight in the claims (the oldest due row's day), which
 * prunes the days that hold nothing to claim.
 *
 * The claims are their services' subselects, copied (the UPDATE around
 * them changes nothing in how the rows are found):
 * notification-pipeline-service.ts (claimEvents, claimDeliveries) and
 * webhook-dispatch-service.ts; queue-claim-by-due.test.ts captures the
 * real statements on the swapped schema. The metrics' window and the
 * bounded purge are the code's own builders.
 */
const prisma = createPrismaClient();
const DAY_MS = 24 * 60 * 60 * 1000;
const TODAY = Math.floor(Date.now() / DAY_MS) * DAY_MS;

const QUEUES = [
  "domain_outbox_event",
  "notification_delivery",
  "notification_provider_receipt",
  "webhook_delivery",
] as const;

/** Settled rows per day and table: a month of traffic, scaled down. */
const ROWS_PER_DAY = 150;

const MAX_BUFFERS = 300;
const MAX_PLANNING_P95_MS = 2;
const PLANNING_RUNS = 40;
const PLANNING_WARMUP_RUNS = 5;

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Shared Hit Blocks"?: number;
  "Shared Read Blocks"?: number;
  Plans?: PlanNode[];
}

interface Explained {
  plan: PlanNode;
  planningMs: number;
}

const stamp = (ms: number) =>
  new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");

function flatten(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flatten)];
}

/** The partitions that hold rows, by name. */
let populated = new Set<string>();

/**
 * One session for every EXPLAIN, as a pooled connection of a replica that
 * claims all day: the planner's caches of the partitions are warm after
 * the first plans, and a pool of fresh connections would measure their
 * cold start ten times over.
 */
let session: pg.Client;

/** EXPLAIN (ANALYZE, BUFFERS) in a transaction that is rolled back. */
async function explain(query: Prisma.Sql): Promise<Explained> {
  await session.query("BEGIN");

  try {
    // As in every plan test: with sequential scans off, a Seq Scan left in
    // the plan means no index applies. A day of a few hundred rows is
    // cheaper read whole, which a real day of a million is not.
    await session.query("SET LOCAL enable_seqscan = off");

    const { rows } = await session.query<{ "QUERY PLAN": unknown }>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.text}`,
      query.values,
    );
    const raw = rows[0]["QUERY PLAN"];
    const [document] = (
      typeof raw === "string" ? JSON.parse(raw) : raw
    ) as Array<{ Plan: PlanNode; "Planning Time": number }>;

    return { plan: document.Plan, planningMs: document["Planning Time"] };
  } finally {
    await session.query("ROLLBACK");
  }
}

function percentile95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);

  return sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)
  ];
}

/**
 * The three gates, with the reason of the one that fails. A statement that
 * reads whole days on purpose (a count of the last 24 hours) may scan
 * them: `wholeDays`.
 */
async function expectWithinGates(
  query: Prisma.Sql,
  {
    wholeDays = false,
    planning: measurePlanning = true,
    buffers: measureBuffers = true,
  }: { wholeDays?: boolean; planning?: boolean; buffers?: boolean } = {},
): Promise<void> {
  const first = await explain(query);
  const nodes = flatten(first.plan);
  const scans = nodes.filter(
    (node) =>
      node["Node Type"] === "Seq Scan" &&
      node["Relation Name"] !== undefined &&
      populated.has(node["Relation Name"]),
  );

  if (!wholeDays) {
    expect(
      scans.map((node) => node["Relation Name"]),
      "varredura sequencial numa partição com linhas",
    ).toEqual([]);
  }

  const buffers =
    (first.plan["Shared Hit Blocks"] ?? 0) +
    (first.plan["Shared Read Blocks"] ?? 0);

  if (measureBuffers) {
    expect(buffers, "buffers lidos").toBeLessThan(MAX_BUFFERS);
  }

  if (!measurePlanning) return;

  // The caches warm first, as on a replica that claims all day.
  for (let run = 0; run < PLANNING_WARMUP_RUNS; run += 1) await explain(query);

  const planning: number[] = [];

  for (let run = 0; run < PLANNING_RUNS; run += 1) {
    planning.push((await explain(query)).planningMs);
  }

  expect(percentile95(planning), "p95 do planejamento (ms)").toBeLessThan(
    MAX_PLANNING_P95_MS,
  );
}

beforeAll(async () => {
  const userId = (
    await prisma.user.create({
      data: {
        name: "Destinatária dos Planos",
        email: `plans-${randomUUID()}@example.com`,
        password: "nao-usado",
        role: "MASTER",
      },
      select: { id: true },
    })
  ).id;

  // The month: the swap's legacy partition (empty in a new database) goes,
  // and a day partition per day from 32 days ago to a week ahead takes its
  // place, beside the swap's own days (which start a day later, past the
  // guard's margin, swapCutoff); the swap's day past the week goes, so each
  // queue has what the retention keeps.
  const firstDay = swapCutoff("day").getTime();

  for (const queue of QUEUES) {
    const [options] = await prisma.$queryRawUnsafe<
      Array<{ options: string[] | null }>
    >(
      `SELECT c.reloptions AS options FROM pg_class c WHERE c.relname = $1`,
      `${queue}_${stamp(firstDay)}`,
    );
    const withOptions = options.options?.length
      ? ` WITH (${options.options.join(", ")})`
      : "";

    await prisma.$executeRawUnsafe(
      `ALTER TABLE "${queue}" DETACH PARTITION "${queue}_legacy"`,
    );
    await prisma.$executeRawUnsafe(`DROP TABLE "${queue}_legacy"`);

    for (let offset = -31; offset <= 7; offset += 1) {
      const from = TODAY + offset * DAY_MS;

      if (from >= firstDay) continue;

      await prisma.$executeRawUnsafe(
        `CREATE TABLE "${queue}_${stamp(from)}" PARTITION OF "${queue}"
           FOR VALUES FROM ('${uuid7Floor(from)}') TO ('${uuid7Floor(from + DAY_MS)}')${withOptions}`,
      );
    }

    for (
      let from = TODAY + 8 * DAY_MS;
      from < firstDay + 7 * DAY_MS;
      from += DAY_MS
    ) {
      await prisma.$executeRawUnsafe(
        `DROP TABLE IF EXISTS "${queue}_${stamp(from)}"`,
      );
    }
  }

  const at = `(to_timestamp(${TODAY / 1000}) - (d * interval '1 day') + (n * interval '1 minute'))`;
  const days = `generate_series(0, 31) AS d, generate_series(1, ${ROWS_PER_DAY}) AS n`;

  // A month of settled events, and today a few waiting.
  await prisma.$executeRawUnsafe(`
    INSERT INTO "domain_outbox_event"
      ("id", "eventKey", "topic", "aggregateType", "aggregateId", "payload",
       "status", "availableAt", "processedAt", "created_at", "updated_at")
    SELECT ${uuid7Sql(at)}, 'plans:' || d || ':' || n, 'delivery.created',
           'delivery', n::text, '{}'::jsonb,
           (CASE WHEN d = 0 AND n % 50 = 0 THEN 'PENDING' ELSE 'PUBLISHED' END)::"OutboxEventStatus",
           ${at}, ${at}, ${at}, ${at}
    FROM ${days}
  `);

  // Two deliveries per event, one per lane, and a few waiting today.
  await prisma.$executeRawUnsafe(`
    INSERT INTO "notification_delivery"
      ("id", "outboxEventId", "userId", "channel", "status", "attempts",
       "availableAt", "created_at", "updated_at")
    SELECT ${uuid7Sql('e."created_at"')}, e."id", '${userId}', c.channel::"NotificationChannel",
           (CASE WHEN e."status" = 'PENDING' THEN 'PENDING' ELSE 'DELIVERED' END)::"NotificationDeliveryStatus",
           1, e."created_at", e."created_at", e."created_at"
    FROM "domain_outbox_event" e
    CROSS JOIN (VALUES ('EMAIL'), ('IN_APP')) AS c(channel)
  `);

  await prisma.$executeRawUnsafe(`
    INSERT INTO "notification_provider_receipt"
      ("id", "deliveryId", "provider", "providerMessageId", "status", "occurredAt", "created_at")
    SELECT ${uuid7Sql('d."created_at"')}, d."id", 'resend', 'email-' || d."id", 'delivered',
           d."created_at", d."created_at"
    FROM "notification_delivery" d
    WHERE d."channel" = 'EMAIL'
  `);

  const business = await prisma.business.create({
    data: {
      corporate_reason: "Transportadora dos Planos",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "11222999000432",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `plans-business-${randomUUID()}@example.com`,
    },
  });

  await prisma.webhookEndpoint.create({
    data: {
      name: "ERP",
      url: "https://erp.example.com/hook",
      secret: "sealed",
      topics: ["delivery.created"],
      businessId: business.id,
    },
  });

  await prisma.$executeRawUnsafe(`
    INSERT INTO "webhook_delivery"
      ("id", "endpointId", "businessId", "topic", "payload", "signature",
       "status", "attempts", "availableAt", "created_at", "updated_at")
    SELECT ${uuid7Sql(at)}, w."id", w."businessId", 'delivery.created', '{}'::jsonb, 'v1=teste',
           (CASE WHEN d = 0 AND n % 50 = 0 THEN 'PENDING' ELSE 'DELIVERED' END)::"WebhookDeliveryStatus",
           1, ${at}, ${at}, ${at}
    FROM ${days}
    CROSS JOIN (SELECT "id", "businessId" FROM "webhook_endpoint" LIMIT 1) AS w
  `);

  await prisma.$executeRawUnsafe(
    `ANALYZE "domain_outbox_event", "notification_delivery", "notification_provider_receipt", "webhook_delivery"`,
  );

  const rows = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT c.relname::text AS name
     FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
     WHERE i.inhparent::regclass::text = ANY($1::text[]) AND c.reltuples > 0`,
    [...QUEUES],
  );

  populated = new Set(rows.map((row) => row.name));
  session = await openReleaseClient(
    process.env.DATABASE_URL as string,
    "e2e-query-plans",
  );
}, 300_000);

afterAll(async () => {
  await session?.end();
  await prisma.$disconnect();
});

describe("the partitioned queues with a month of days", () => {
  it("have 39 partitions each, a month of them holding rows", async () => {
    const rows = await prisma.$queryRawUnsafe<
      Array<{ parent: string; partitions: number }>
    >(
      `SELECT i.inhparent::regclass::text AS parent, count(*)::int AS partitions
       FROM pg_inherits i
       WHERE i.inhparent::regclass::text = ANY($1::text[])
       GROUP BY 1 ORDER BY 1`,
      [...QUEUES],
    );

    expect(rows).toEqual(
      [...QUEUES].sort().map((parent) => ({ parent, partitions: 39 })),
    );
    expect(populated.size).toBe(4 * 32);
  });

  // The range of ids in flight (plan B, QUEUE_CLAIM_ID_FLOOR_ENABLED):
  // today holds the only rows waiting, so the claims read yesterday, today
  // and tomorrow.
  const floors = createClaimFloors({ db: prisma, enabled: () => true });
  const floor = (queue: ClaimFloorQueue) => floors.predicate(queue);

  it("claim the outbox within the gates, with the floor of ids in flight", async () => {
    await expectWithinGates(outboxClaimSql(await floor("outbox")));
  });

  it("claim each delivery lane within the gates, with the floor", async () => {
    for (const lane of ["internal", "external"] as const) {
      await expectWithinGates(
        deliveryClaimSql(lane, await floor("deliveries")),
      );
    }
  });

  it("claim the webhooks within the gates, with the floor", async () => {
    await expectWithinGates(webhookClaimSql(await floor("webhooks")));
  });

  it("claim every queue through an index without the floor too", async () => {
    // The claims with the floor off, as they ship: every partition probed
    // through its claim index, never read whole. Their planning and the
    // probes of a month of days are what the floor saves (measured here at
    // two to three times the gates).
    for (const claim of [
      outboxClaimSql(Prisma.empty),
      deliveryClaimSql("internal", Prisma.empty),
      deliveryClaimSql("external", Prisma.empty),
      webhookClaimSql(Prisma.empty),
    ]) {
      await expectWithinGates(claim, { planning: false, buffers: false });
    }
  });

  it("puts the range from yesterday to tomorrow with nothing older in flight, and under an old row in flight", async () => {
    const yesterday = uuid7Floor(TODAY - DAY_MS);
    const afterTomorrow = uuid7Floor(TODAY + 2 * DAY_MS);

    expect((await floor("outbox")).values).toEqual([yesterday, afterTomorrow]);

    // An event waiting for five days holds the outbox's floor, and the
    // deliveries' (its deliveries are not written yet).
    const old = TODAY - 5 * DAY_MS + 3_600_000;

    await prisma.$executeRawUnsafe(
      `UPDATE "domain_outbox_event" SET "status" = 'PENDING'
       WHERE "id" = (SELECT min("id") FROM "domain_outbox_event" WHERE "id" >= $1)`,
      uuid7Floor(old),
    );

    const fresh = createClaimFloors({ db: prisma, enabled: () => true });
    const fiveDaysAgo = uuid7Floor(TODAY - 5 * DAY_MS);

    expect((await fresh.predicate("outbox")).values).toEqual([
      fiveDaysAgo,
      afterTomorrow,
    ]);
    expect((await fresh.predicate("deliveries")).values).toEqual([
      fiveDaysAgo,
      afterTomorrow,
    ]);
    expect((await fresh.predicate("webhooks")).values).toEqual([
      yesterday,
      afterTomorrow,
    ]);

    // Off, or on a plain queue: no floor at all.
    expect(
      (
        await createClaimFloors({
          db: prisma,
          enabled: () => false,
        }).predicate("outbox")
      ).sql,
    ).toBe("");
  });

  it("count the metrics' day of deliveries within the gates, through the days it covers", async () => {
    const window = deliveriesInWindowSql(new Date(Date.now() - DAY_MS));

    await expectWithinGates(window, { wholeDays: true });

    // A range of ids: the planner keeps the two days it can touch.
    const { plan } = await explain(window);
    const read = new Set(
      flatten(plan)
        .map((node) => node["Relation Name"])
        .filter((name): name is string => Boolean(name)),
    );

    expect(read.size).toBeLessThanOrEqual(2 + 7);
  });

  it("purge in batches below the legacy bound without reading a single day", async () => {
    // The legacy partition is gone here: the bound is the oldest day's
    // start, and the batch prunes every partition.
    const batch = publishedPurgeBatchSql(
      new Date(Date.now() - 30 * DAY_MS),
      5_000,
      uuid7Floor(TODAY - 31 * DAY_MS),
    );
    const { plan } = await explain(batch);
    const named = await withParentNames(prisma, plan);

    expect(
      flatten(named).filter(
        (node) =>
          node["Node Type"].endsWith("Scan") &&
          node["Relation Name"] === "domain_outbox_event",
      ),
    ).toEqual([]);
  });

  it("report each queue's bloat summed over its partitions", async () => {
    // The statistics collector sees every partition's rows; the parent's
    // own line is always empty.
    await vi.waitFor(
      async () => {
        const rows = await prisma.$queryRaw<
          Array<{
            table_name: string;
            partitions: number;
            n_live_tup: number;
          }>
        >(queueTableStatsSql());
        const outbox = rows.find(
          (row) => row.table_name === "domain_outbox_event",
        );

        expect(outbox?.partitions).toBe(39);
        expect(Number(outbox?.n_live_tup)).toBeGreaterThanOrEqual(
          32 * ROWS_PER_DAY * 0.9,
        );
        expect(rows.map((row) => row.table_name)).toContain(
          "notification_provider_receipt",
        );
      },
      { timeout: 15_000, interval: 250 },
    );
  });
});
