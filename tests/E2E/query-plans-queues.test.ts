import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Prisma } from "@prisma/client";

import { createPrismaClient } from "@/shared/database/database-client";
import {
  webhookCappedClaimSql,
  webhookClaimSql,
} from "@/shared/integration/webhook-dispatch-service";
import {
  deliveryClaimSql,
  deliveryFairClaimSql,
  outboxClaimSql,
  outboxFairClaimSql,
} from "@/shared/notifications/notification-pipeline-service";
import {
  DELIVERY_LANES,
  DELIVERY_MAX_ATTEMPTS,
  OUTBOX_MAX_ATTEMPTS,
} from "@/shared/notifications/pipeline-rules";
import { WEBHOOK_MAX_ATTEMPTS } from "@/shared/integration/webhook-dispatch-rules";
import {
  exhaustedCloseSql,
  type ExhaustedQueueTable,
} from "@/shared/queue/exhausted-close";

import { uuid7Sql } from "./support/uuid7-sql";

/**
 * The queues' hot statements under a backlog of due rows (plano-escala
 * F3-08).
 *
 * The close of the exhausted rows — PROCESSING, lease run out, attempts at
 * the ceiling — ran before every claim and found its rows through the
 * claim's own index: every due row, PENDING ones included, read in the heap
 * to find the few in flight. In a flood of twenty thousand due e-mails, each
 * claim of five read the twenty thousand first. It is a minute's timer now,
 * reading a partial index of the rows in flight.
 *
 * What this measures, with the code's own builders, EXPLAIN (ANALYZE,
 * BUFFERS) in a transaction rolled back:
 *
 *  - the close reads the same pages with a thousand due rows queued and
 *    with twenty-one thousand: its cost does not follow the backlog;
 *  - it closes the exhausted rows and nothing else (a live lease, a due
 *    PENDING row);
 *  - the claims, one statement each, read a bounded number of pages with
 *    the backlog in front of them;
 *  - the fair claim of a lane (F3-10), with a long tail: one company with
 *    a hundred thousand due rows and 3,599 with one each. Its skip scan
 *    costs two short probes per company it visits, never a read of the big
 *    one's rows, wherever the cursor stands, and one claim takes rows of
 *    several companies.
 *
 * On the swapped schema every E2E database runs: the queues partitioned by
 * day, the seeds minting v7 ids (support/uuid7-sql.ts).
 */
const prisma = createPrismaClient();

const BUSINESS = "018fc000-0000-7000-8000-0000000013b1";
const ENDPOINT = "018fc000-0000-7000-8000-0000000013b2";
const USER = "018fc000-0000-7000-8000-0000000013b3";

const SMALL_BACKLOG = 1_000;
const LARGE_BACKLOG = 20_000;

/** Pages a claim of five may read in front of a backlog. */
const MAX_CLAIM_PAGES = 300;

/** Pages the close may read more with twenty times the backlog: none. */
const BACKLOG_PAGE_SLACK = 5;

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Shared Hit Blocks"?: number;
  "Shared Read Blocks"?: number;
  Plans?: PlanNode[];
}

function flatten(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flatten)];
}

/**
 * Pages the statement read to find and lock its rows: the LockRows node of
 * its subselect, children included (a node counts its children's). The
 * UPDATE above it also writes every index of each row it takes, which
 * grows with the indexes' depth, not with what the statement had to read.
 */
function pagesToFind(plan: PlanNode): number {
  const lock = flatten(plan).find((node) => node["Node Type"] === "LockRows");

  if (!lock) throw new Error("o plano não tem o nó LockRows do subselect");

  return (lock["Shared Hit Blocks"] ?? 0) + (lock["Shared Read Blocks"] ?? 0);
}

/**
 * EXPLAIN (ANALYZE, BUFFERS) of a statement that writes, in a transaction
 * rolled back. Sequential scans off, as in every plan test: a Seq Scan left
 * means no index applies.
 */
async function explain(query: Prisma.Sql): Promise<PlanNode> {
  let plan: PlanNode | undefined;

  await prisma
    .$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");

      const rows = await tx.$queryRawUnsafe<{ "QUERY PLAN": unknown }[]>(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.text}`,
        ...query.values,
      );

      const raw = rows[0]["QUERY PLAN"];
      plan = (
        (typeof raw === "string" ? JSON.parse(raw) : raw) as Array<{
          Plan: PlanNode;
        }>
      )[0].Plan;

      throw new Error("rollback");
    })
    .catch((error: Error) => {
      if (error.message !== "rollback") throw error;
    });

  return plan!;
}

function noSeqScan(plan: PlanNode): string[] {
  return flatten(plan)
    .filter((node) => node["Node Type"] === "Seq Scan")
    .map((node) => String(node["Relation Name"]));
}

/** `count` due PENDING rows in each queue, older than now. */
async function queueBacklog(count: number): Promise<void> {
  const at = "now() - interval '5 minutes'";

  await prisma.$executeRawUnsafe(
    `
    INSERT INTO "domain_outbox_event" (
      "id", "eventKey", "topic", "aggregateType", "aggregateId", "businessId",
      "payload", "status", "availableAt", "created_at", "updated_at"
    )
    SELECT ${uuid7Sql(at)}, 'backlog:' || gen_random_uuid(), 'account-payable.created',
           'account-payable', gen_random_uuid()::text, $1, '{}'::jsonb,
           'PENDING', ${at}, ${at}, now()
    FROM generate_series(1, ${count})
    `,
    BUSINESS,
  );

  await prisma.$executeRawUnsafe(
    `
    INSERT INTO "notification_delivery" (
      "id", "outboxEventId", "userId", "channel", "status", "attempts",
      "availableAt", "business_id", "created_at", "updated_at"
    )
    SELECT ${uuid7Sql(at)}, gen_random_uuid()::text, $1, 'EMAIL', 'PENDING', 0,
           ${at}, $2, ${at}, now()
    FROM generate_series(1, ${count})
    `,
    USER,
    BUSINESS,
  );

  await prisma.$executeRawUnsafe(
    `
    INSERT INTO "webhook_delivery" (
      "id", "endpointId", "topic", "payload", "signature", "status",
      "attempts", "availableAt", "businessId", "created_at", "updated_at"
    )
    SELECT ${uuid7Sql(at)}, $1, 'delivery.delivered', '{}'::jsonb, 'sig',
           'PENDING', 0, ${at}, $2, ${at}, now()
    FROM generate_series(1, ${count})
    `,
    ENDPOINT,
    BUSINESS,
  );

  for (const table of [
    "domain_outbox_event",
    "notification_delivery",
    "webhook_delivery",
  ]) {
    await prisma.$executeRawUnsafe(`ANALYZE "${table}"`);
  }
}

/**
 * Per queue, three rows whose last attempt died (lease run out at the
 * ceiling) and one still in flight at the ceiling, its lease alive.
 */
async function inFlight(): Promise<void> {
  const lease = (alive: boolean) =>
    alive ? "now() + interval '1 minute'" : "now() - interval '1 minute'";

  for (const alive of [false, false, false, true]) {
    await prisma.$executeRawUnsafe(
      `
      INSERT INTO "domain_outbox_event" (
        "id", "eventKey", "topic", "aggregateType", "aggregateId",
        "businessId", "payload", "status", "attempts", "availableAt",
        "leaseExpiresAt", "created_at", "updated_at"
      )
      VALUES (${uuid7Sql()}, 'flight:' || gen_random_uuid(), 'account-payable.created',
              'account-payable', gen_random_uuid()::text, $1, '{}'::jsonb,
              'PROCESSING', ${OUTBOX_MAX_ATTEMPTS}, ${lease(alive)},
              ${lease(alive)}, now(), now())
      `,
      BUSINESS,
    );

    await prisma.$executeRawUnsafe(
      `
      INSERT INTO "notification_delivery" (
        "id", "outboxEventId", "userId", "channel", "status", "attempts",
        "availableAt", "leaseExpiresAt", "business_id", "created_at",
        "updated_at"
      )
      VALUES (${uuid7Sql()}, gen_random_uuid()::text, $1, 'EMAIL', 'PROCESSING',
              ${DELIVERY_MAX_ATTEMPTS}, ${lease(alive)}, ${lease(alive)}, $2,
              now(), now())
      `,
      USER,
      BUSINESS,
    );

    await prisma.$executeRawUnsafe(
      `
      INSERT INTO "webhook_delivery" (
        "id", "endpointId", "topic", "payload", "signature", "status",
        "attempts", "availableAt", "leaseExpiresAt", "businessId",
        "created_at", "updated_at"
      )
      VALUES (${uuid7Sql()}, $1, 'delivery.delivered', '{}'::jsonb, 'sig',
              'PROCESSING', ${WEBHOOK_MAX_ATTEMPTS}, ${lease(alive)},
              ${lease(alive)}, $2, now(), now())
      `,
      ENDPOINT,
      BUSINESS,
    );
  }
}

const CLOSES: Array<{ table: ExhaustedQueueTable; sql: () => Prisma.Sql }> = [
  {
    table: "domain_outbox_event",
    sql: () =>
      exhaustedCloseSql({
        table: "domain_outbox_event",
        maxAttempts: OUTBOX_MAX_ATTEMPTS,
        floor: Prisma.empty,
      }),
  },
  {
    table: "notification_delivery",
    sql: () =>
      exhaustedCloseSql({
        table: "notification_delivery",
        maxAttempts: DELIVERY_MAX_ATTEMPTS,
        floor: Prisma.empty,
        channels: [...DELIVERY_LANES.internal, ...DELIVERY_LANES.external],
      }),
  },
  {
    table: "webhook_delivery",
    sql: () =>
      exhaustedCloseSql({
        table: "webhook_delivery",
        maxAttempts: WEBHOOK_MAX_ATTEMPTS,
        floor: Prisma.empty,
      }),
  },
];

const smallPages = new Map<ExhaustedQueueTable, number>();

beforeAll(async () => {
  await inFlight();
  await queueBacklog(SMALL_BACKLOG);

  for (const close of CLOSES) {
    smallPages.set(close.table, pagesToFind(await explain(close.sql())));
  }

  await queueBacklog(LARGE_BACKLOG);
}, 300_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("the close of the exhausted rows (F3-08)", () => {
  it.each(CLOSES.map((close) => [close.table, close] as const))(
    "reads the same pages on %s whatever is queued behind the rows in flight",
    async (_table, close) => {
      const plan = await explain(close.sql());
      const pages = pagesToFind(plan);
      const before = smallPages.get(close.table)!;

      expect(noSeqScan(plan)).toEqual([]);
      expect(
        pages,
        `${close.table}: ${before} páginas com ${SMALL_BACKLOG} na fila, ${pages} com ${SMALL_BACKLOG + LARGE_BACKLOG}`,
      ).toBeLessThanOrEqual(before + BACKLOG_PAGE_SLACK);
    },
    60_000,
  );

  it.each(CLOSES.map((close) => [close.table, close] as const))(
    "closes on %s the rows whose last attempt died, and nothing else",
    async (table, close) => {
      // Run for real, then put back: the other cases measure the same rows.
      await prisma
        .$transaction(async (tx) => {
          const closed = await tx.$executeRawUnsafe(
            close.sql().text,
            ...close.sql().values,
          );

          expect(closed).toBe(3);

          const left = await tx.$queryRawUnsafe<
            Array<{ status: string; n: number }>
          >(
            `SELECT "status"::text AS status, count(*)::int AS n FROM "${table}" GROUP BY 1 ORDER BY 1`,
          );

          expect(left).toEqual([
            { status: "FAILED", n: 3 },
            { status: "PENDING", n: SMALL_BACKLOG + LARGE_BACKLOG },
            { status: "PROCESSING", n: 1 },
          ]);

          throw new Error("rollback");
        })
        .catch((error: Error) => {
          if (error.message !== "rollback") throw error;
        });
    },
    60_000,
  );
});

describe("the claims, one statement each, in front of the backlog", () => {
  const CLAIMS: Array<[string, () => Prisma.Sql]> = [
    ["the outbox", () => outboxClaimSql(Prisma.empty, 5)],
    [
      "the outbox's fair claim (F3-11)",
      () =>
        outboxFairClaimSql({
          cursor: "",
          limit: 5,
          rowsPerTenant: 2,
          maxTenants: 64,
          floor: Prisma.empty,
          rowFloor: Prisma.empty,
        }),
    ],
    ["the external lane", () => deliveryClaimSql("external", Prisma.empty, 5)],
    ["the webhooks", () => webhookClaimSql(Prisma.empty, 5)],
    [
      "the webhooks under the global cap per endpoint (F3-13)",
      () =>
        webhookCappedClaimSql({
          cursor: "",
          limit: 5,
          endpointCap: 4,
          perEndpoint: 2,
          floor: Prisma.empty,
          rowFloor: Prisma.empty,
        }),
    ],
  ];

  it.each(CLAIMS)(
    "%s reads a bounded number of pages",
    async (what, sql) => {
      const plan = await explain(sql());
      const pages = pagesToFind(plan);

      expect(noSeqScan(plan)).toEqual([]);
      expect(
        pages,
        `${what}: ${pages} páginas para um claim de 5`,
      ).toBeLessThan(MAX_CLAIM_PAGES);
    },
    60_000,
  );
});

describe("the fair claim of a lane, with a long tail (F3-10)", () => {
  const BIG = "018fd000-0000-7000-8000-000000000000";
  const TAIL = 3_599;
  const BIG_ROWS = 100_000;

  /** Pages the fair claim may read to find and lock five rows. */
  const MAX_FAIR_PAGES = 300;

  const tailTenant = (n: number) =>
    `018fd000-0000-7000-8000-${String(n).padStart(12, "0")}`;

  beforeAll(async () => {
    const at = "now() - interval '5 minutes'";

    await prisma.$executeRawUnsafe(
      `
      INSERT INTO "notification_delivery" (
        "id", "outboxEventId", "userId", "channel", "status", "attempts",
        "availableAt", "business_id", "created_at", "updated_at"
      )
      SELECT ${uuid7Sql(at)}, gen_random_uuid()::text, $1, 'EMAIL', 'PENDING', 0,
             ${at} - n * interval '1 millisecond', $2, ${at}, now()
      FROM generate_series(1, ${BIG_ROWS}) AS n
      `,
      USER,
      BIG,
    );

    await prisma.$executeRawUnsafe(
      `
      INSERT INTO "notification_delivery" (
        "id", "outboxEventId", "userId", "channel", "status", "attempts",
        "availableAt", "business_id", "created_at", "updated_at"
      )
      SELECT ${uuid7Sql(at)}, gen_random_uuid()::text, $1, 'EMAIL', 'PENDING', 0,
             ${at}, '018fd000-0000-7000-8000-' || lpad(n::text, 12, '0'), ${at}, now()
      FROM generate_series(1, ${TAIL}) AS n
      `,
      USER,
    );

    await prisma.$executeRawUnsafe('ANALYZE "notification_delivery"');
  }, 300_000);

  const fair = (cursor: string) =>
    deliveryFairClaimSql("external", {
      cursor,
      limit: 5,
      rowsPerTenant: 2,
      maxTenants: 64,
      floor: Prisma.empty,
      rowFloor: Prisma.empty,
    });

  const CURSORS: Array<[string, string]> = [
    ["from the start", ""],
    ["just before the big company", "018fc999"],
    ["in the middle of the tail", tailTenant(1_800)],
    ["past the last company", "ffffffff"],
  ];

  it.each(CURSORS)(
    "reads a bounded number of pages %s",
    async (where, cursor) => {
      const plan = await explain(fair(cursor));
      const pages = pagesToFind(plan);

      expect(noSeqScan(plan)).toEqual([]);
      expect(
        pages,
        `cursor ${where}: ${pages} páginas para um claim justo de 5`,
      ).toBeLessThan(MAX_FAIR_PAGES);
    },
    60_000,
  );

  it("takes rows of several companies, the big one no more than its share", async () => {
    await prisma
      .$transaction(async (tx) => {
        const rows = await tx.$queryRawUnsafe<
          Array<{ id: string; fairCursor: string }>
        >(fair("018fc999").text, ...fair("018fc999").values);

        expect(rows).toHaveLength(5);

        const owners = await tx.$queryRawUnsafe<Array<{ business_id: string }>>(
          `SELECT "business_id" FROM "notification_delivery" WHERE "id" = ANY($1::text[])`,
          rows.map((row) => row.id),
        );
        const counts = new Map<string, number>();

        for (const owner of owners) {
          counts.set(
            owner.business_id,
            (counts.get(owner.business_id) ?? 0) + 1,
          );
        }

        expect(counts.get(BIG)).toBe(2);
        expect(counts.size).toBeGreaterThanOrEqual(3);

        // The next claim starts after the last company this one visited.
        expect(rows[0].fairCursor > BIG).toBe(true);

        throw new Error("rollback");
      })
      .catch((error: Error) => {
        if (error.message !== "rollback") throw error;
      });
  }, 60_000);
});
