import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Prisma, PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import {
  aiFailedSinceSql,
  aiQueueSql,
  operationalSnapshotSql,
  outboxFailedSql,
  outboxPendingSql,
  deadLetterCountSql,
  deadLetterPageSql,
  deliveriesInWindowSql,
  deliveryBacklogSql,
  failedByChannelSql,
  webhookFailedSinceSql,
  whatsappFailedSinceSql,
  whatsappMultiSendSinceSql,
} from "@/shared/health/metrics-queries";

/**
 * What /health/metrics and /health/dead-letter cost at volume (OBS-09, PG-18).
 *
 * Both used to read notification_delivery — the widest table of the pipeline,
 * tens of millions of rows at the target scale — with no index that served
 * them: a groupBy over "created in the last 24 h" for every status, a groupBy
 * on status = 'FAILED', and the dead letter's count and page ordered by
 * updated_at. Each opening of the MASTER's screen was two sequential scans,
 * and the alerting that is meant to poll these numbers would have made the
 * observability itself the load.
 *
 * Two conditions on every plan here, both on purpose:
 *  - `enable_seqscan = off`: with no index able to answer, Postgres still
 *    produces a (penalised) Seq Scan, so its presence means "no index applies"
 *    rather than "the table is small";
 *  - a GENERIC plan (`plan_cache_mode = force_generic_plan` over PREPARE): the
 *    route's statements are prepared and reused, and after a few executions
 *    Postgres may switch to the plan that ignores the bound values. A partial
 *    index is only usable there when its predicate is a literal in the SQL —
 *    `status = $1` cannot prove `status = 'FAILED'`.
 */
const prisma = new PrismaClient();

const USER = "018fda60-0000-7000-8000-0000000000u1";

/** Deliveries seeded; five per event (one per channel), over 30 days. */
const EVENTS = 6_000;

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  Plans?: PlanNode[];
}

function flatten(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flatten)];
}

/** A value of `query.values`, spelled as the EXECUTE argument it binds to. */
function literal(value: unknown): string {
  if (value instanceof Date) return `'${value.toISOString()}'`;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    return `ARRAY[${value.map((item) => literal(item)).join(", ")}]`;
  }

  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * The generic plan of `query`, with sequential scans switched off.
 *
 * PREPARE turns Prisma's `$1..$n` into statement parameters, exactly as the
 * driver does, and force_generic_plan makes EXECUTE use the plan that does
 * not look at their values.
 */
async function genericPlan(query: Prisma.Sql): Promise<PlanNode> {
  const name = `metrics_plan_${randomUUID().replace(/-/g, "")}`;

  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
    await tx.$executeRawUnsafe(
      "SET LOCAL plan_cache_mode = force_generic_plan",
    );
    // `.text` is the Postgres spelling ($1..$n); `.sql` is MySQL's (?).
    await tx.$executeRawUnsafe(`PREPARE ${name} AS ${query.text}`);

    const args = query.values.length
      ? `(${query.values.map(literal).join(", ")})`
      : "";

    const [row] = await tx.$queryRawUnsafe<Array<{ "QUERY PLAN": unknown }>>(
      `EXPLAIN (FORMAT JSON) EXECUTE ${name}${args}`,
    );

    await tx.$executeRawUnsafe(`DEALLOCATE ${name}`);

    const document = row["QUERY PLAN"] as Array<{ Plan: PlanNode }>;

    return document[0].Plan;
  });
}

function seqScansOn(plan: PlanNode, table: string): PlanNode[] {
  return flatten(plan).filter(
    (node) =>
      node["Node Type"] === "Seq Scan" && node["Relation Name"] === table,
  );
}

function indexesUsed(plan: PlanNode): string[] {
  return flatten(plan)
    .map((node) => node["Index Name"])
    .filter((name): name is string => Boolean(name));
}

beforeAll(async () => {
  await prisma.user.create({
    data: {
      id: USER,
      name: "Destinatária das Métricas",
      email: `plans-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "MASTER",
    },
  });

  // Events spread over 30 days, most PUBLISHED; deliveries mostly DELIVERED,
  // with the FAILED and in-flight minority a real table has.
  await prisma.$executeRawUnsafe(`
    INSERT INTO "domain_outbox_event"
      ("id", "eventKey", "topic", "aggregateType", "aggregateId", "payload",
       "status", "availableAt", "processedAt", "created_at", "updated_at")
    SELECT
      gen_random_uuid()::text, 'plans-' || g, 'metrics.plans', 'plans', g::text, '{}'::jsonb,
      'PUBLISHED', now() - (g * interval '432 seconds'), now() - (g * interval '432 seconds'),
      now() - (g * interval '432 seconds'), now() - (g * interval '432 seconds')
    FROM generate_series(1, ${EVENTS}) AS g
  `);

  await prisma.$executeRawUnsafe(`
    INSERT INTO "notification_delivery"
      ("id", "outboxEventId", "userId", "channel", "status", "attempts",
       "availableAt", "created_at", "updated_at")
    SELECT
      gen_random_uuid()::text, e."id", '${USER}', c.channel::"NotificationChannel",
      (CASE
        WHEN random() < 0.03 THEN 'FAILED'
        WHEN random() < 0.02 THEN 'PENDING'
        ELSE 'DELIVERED'
      END)::"NotificationDeliveryStatus",
      1, e."created_at", e."created_at", e."created_at"
    FROM "domain_outbox_event" e
    CROSS JOIN (VALUES ('IN_APP'), ('EMAIL'), ('WHATSAPP'), ('ACTIVITY'), ('PUSH')) AS c(channel)
    WHERE e."topic" = 'metrics.plans'
  `);

  // Meta's callbacks for every WhatsApp: sent, delivered, read — and a second
  // wamid for a few, the duplicate the metric looks for. Plus Expo tickets, so
  // the provider column has more than one value to tell apart.
  await prisma.$executeRawUnsafe(`
    INSERT INTO "notification_provider_receipt"
      ("id", "deliveryId", "provider", "providerMessageId", "status", "occurredAt", "created_at")
    SELECT
      gen_random_uuid()::text, d."id", 'meta', 'wamid.' || d."id" || '.' || w.n, s.status,
      d."created_at", d."created_at"
    FROM "notification_delivery" d
    CROSS JOIN (VALUES ('sent'), ('delivered'), ('read')) AS s(status)
    CROSS JOIN generate_series(1, 2) AS w(n)
    WHERE d."channel" = 'WHATSAPP' AND (w.n = 1 OR random() < 0.01)
  `);

  await prisma.$executeRawUnsafe(`
    INSERT INTO "notification_provider_receipt"
      ("id", "deliveryId", "provider", "providerMessageId", "status", "occurredAt", "created_at")
    SELECT
      gen_random_uuid()::text, d."id", 'expo', 'ticket.' || d."id", 'ok', d."created_at", d."created_at"
    FROM "notification_delivery" d
    WHERE d."channel" = 'PUSH'
  `);

  await prisma.$executeRawUnsafe(`ANALYZE "notification_delivery"`);
  await prisma.$executeRawUnsafe(`ANALYZE "domain_outbox_event"`);
  await prisma.$executeRawUnsafe(`ANALYZE "notification_provider_receipt"`);
}, 180_000);

afterAll(async () => {
  await prisma.$disconnect();
});

const DAY_MS = 24 * 60 * 60 * 1000;

describe("the detector itself", () => {
  it("sees a sequential scan when the status is a bound parameter", async () => {
    /**
     * The shape Prisma's groupBy sends — the old route. Under a generic plan
     * nothing can prove the partial failed index, so the planner falls back to
     * the table. Kept so a broken detector cannot pass everything below.
     */
    const plan = await genericPlan(
      Prisma.sql`
        SELECT "channel", count(*) FROM "notification_delivery"
        WHERE "status" = CAST(${"FAILED"}::text AS "NotificationDeliveryStatus")
        GROUP BY "channel"
      `,
    );

    expect(seqScansOn(plan, "notification_delivery")).not.toHaveLength(0);
  });
});

describe("/health/metrics never scans notification_delivery", () => {
  it.each([
    [
      "created in the last 24 h",
      () => deliveriesInWindowSql(new Date(Date.now() - DAY_MS)),
    ],
    ["failed per channel", () => failedByChannelSql()],
    ["internal lane backlog", () => deliveryBacklogSql("internal")],
    ["external lane backlog", () => deliveryBacklogSql("external")],
  ])("%s", async (_label, build) => {
    const plan = await genericPlan(build());

    expect(
      seqScansOn(plan, "notification_delivery"),
      JSON.stringify(plan),
    ).toHaveLength(0);
  });

  it("and the 24 h window is a range of the primary key, not the BRIN", async () => {
    // The BRIN on created_at stops narrowing once the heap is reused; see
    // health-metrics-window-scan.test.ts.
    const plan = await genericPlan(
      deliveriesInWindowSql(new Date(Date.now() - DAY_MS)),
    );

    expect(indexesUsed(plan)).toContain("notification_delivery_pkey");
    expect(indexesUsed(plan)).not.toContain(
      "notification_delivery_created_at_brin_idx",
    );
  });

  it("and the failures per channel come from the failed index", async () => {
    const plan = await genericPlan(failedByChannelSql());

    expect(indexesUsed(plan)).toContain("notification_delivery_failed_idx");
  });

  it("and each lane's backlog from that lane's claim index", async () => {
    expect(
      indexesUsed(await genericPlan(deliveryBacklogSql("internal"))),
    ).toContain("notification_delivery_claim_internal_idx");

    expect(
      indexesUsed(await genericPlan(deliveryBacklogSql("external"))),
    ).toContain("notification_delivery_claim_external_idx");
  });

  it("nor webhook_delivery or ai_analysis_request for the failures of the day", async () => {
    const since = new Date(Date.now() - DAY_MS);

    const webhookPlan = await genericPlan(webhookFailedSinceSql(since));
    expect(seqScansOn(webhookPlan, "webhook_delivery")).toHaveLength(0);
    expect(indexesUsed(webhookPlan)).toContain("webhook_delivery_failed_idx");

    const aiPlan = await genericPlan(aiFailedSinceSql(since));
    expect(seqScansOn(aiPlan, "ai_analysis_request")).toHaveLength(0);
  });
});

/**
 * The twenty-odd statements of /health/metrics are now subqueries of one
 * (operationalSnapshotSql): one round trip and one pool checkout instead of
 * twenty-two. Postgres plans each subquery on its own, so the whole must keep
 * every guarantee its parts have — no queue table read sequentially.
 */
describe("/health/metrics in one statement", () => {
  it("scans none of the queue tables sequentially", async () => {
    const plan = await genericPlan(
      operationalSnapshotSql(new Date(Date.now() - DAY_MS)),
    );

    for (const table of [
      "notification_delivery",
      "notification_provider_receipt",
      "domain_outbox_event",
      "ai_analysis_request",
      "webhook_delivery",
    ]) {
      expect(
        seqScansOn(plan, table),
        `${table}: ${JSON.stringify(plan)}`,
      ).toHaveLength(0);
    }

    expect(indexesUsed(plan)).toEqual(
      expect.arrayContaining([
        "notification_delivery_failed_idx",
        "notification_delivery_claim_internal_idx",
        "notification_delivery_claim_external_idx",
        "webhook_delivery_failed_idx",
        "notification_provider_receipt_provider_status_created_at_idx",
      ]),
    );
  });

  it.each([
    [
      "outbox pending and lags",
      () => outboxPendingSql(),
      "domain_outbox_event",
    ],
    ["outbox failed", () => outboxFailedSql(), "domain_outbox_event"],
    ["AI queue", () => aiQueueSql(), "ai_analysis_request"],
  ])("and its %s part reads an index", async (_label, build, table) => {
    const plan = await genericPlan(build());

    expect(seqScansOn(plan, table), JSON.stringify(plan)).toHaveLength(0);
  });
});

describe("/health/metrics reads Meta's word on WhatsApp from an index (OUTBOX-07)", () => {
  /**
   * The provider receipts ledger grows with every callback — three or four
   * rows per WhatsApp sent — and is kept 30 days. Both numbers read the last
   * 24 hours of it through (provider, status, created_at), with provider and
   * statuses as literals like every other query of the endpoint.
   */
  it.each([
    [
      "failed after Meta accepted them",
      () => whatsappFailedSinceSql(new Date(Date.now() - DAY_MS)),
    ],
    [
      "deliveries that reached Meta more than once",
      () => whatsappMultiSendSinceSql(new Date(Date.now() - DAY_MS)),
    ],
  ])("%s", async (_label, build) => {
    const plan = await genericPlan(build());

    expect(
      seqScansOn(plan, "notification_provider_receipt"),
      JSON.stringify(plan),
    ).toHaveLength(0);

    expect(indexesUsed(plan)).toContain(
      "notification_provider_receipt_provider_status_created_at_idx",
    );
  });
});

describe("/health/dead-letter never scans notification_delivery", () => {
  it.each([
    ["count, every channel", () => deadLetterCountSql()],
    ["count, one channel", () => deadLetterCountSql("WHATSAPP")],
    ["page, every channel", () => deadLetterPageSql(undefined, 20, 40)],
    ["page, one channel", () => deadLetterPageSql("EMAIL", 20, 0)],
  ])("%s", async (_label, build) => {
    const plan = await genericPlan(build());

    expect(
      seqScansOn(plan, "notification_delivery"),
      JSON.stringify(plan),
    ).toHaveLength(0);

    expect(indexesUsed(plan)).toContain("notification_delivery_failed_idx");
  });
});
