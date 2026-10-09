import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { DeliveryRepository } from "@/modules/delivery/repositories/delivery-repository";
import { OperationDayRepository } from "@/modules/route/repositories/operation-day-repository";
import { readOperationSummary } from "@/modules/delivery/usecases/operation-summary/read-operation-summary";
import {
  DEFAULT_BUSINESS_TIMEZONE,
  businessDayRange,
  type BusinessDayRange,
} from "@/shared/time/business-day";
import { operationDay } from "@/shared/route/operation-day-rules";

/**
 * What the delivery screens cost once a carrier has a history.
 *
 * query-plans.test.ts seeds a fixture where a quarter of every company is
 * PENDING and everything was touched today. That is a fine fixture for the
 * listing and a flattering one for everything that asks about TODAY: when the
 * whole table is today, reading all of it and reading today's rows are the
 * same work. A real carrier is the opposite — tens of thousands of deliveries
 * finished months ago, a few dozen open, a handful finished today — and the
 * questions that go wrong are exactly the ones whose cost grows with the old
 * rows instead of the new ones.
 *
 * So this file seeds that shape and measures, on the SQL the repository really
 * sends, how many rows each statement touches: rows returned plus rows read
 * and thrown away by a filter, on every scan of the table. The access path is
 * checked twice. Once with the values bound, as the first executions run, and
 * once as a GENERIC plan, which is what Postgres switches a prepared statement
 * to after five executions on the same connection — and the plan that cannot
 * see that `status = $2` means 'DELIVERED'.
 */
const prisma = new PrismaClient();

const HISTORY = "018fdc00-0000-7000-8000-00000000000a";
const SMALL = "018fdc00-0000-7000-8000-00000000000b";

const HISTORY_SHIPPER = "018fdc00-0000-7000-8000-0000000000f1";
const SMALL_SHIPPER = "018fdc00-0000-7000-8000-0000000000f2";

const REPORTER = "018fdc00-0000-7000-8000-0000000000a1";
const HISTORY_TYPE = "018fdc00-0000-7000-8000-0000000000c1";
const SMALL_TYPE = "018fdc00-0000-7000-8000-0000000000c2";

/** A year and a half of finished work, one delivery every fifteen minutes. */
const HISTORY_VOLUME = 40_000;

/** A small carrier exporting next to a big one. */
const SMALL_VOLUME = 5_000;

const OPEN_PENDING = 40;
const OPEN_IN_TRANSIT = 20;
const DELIVERED_TODAY = 10;
const FAILED_TODAY = 5;

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  "Rows Removed by Filter"?: number;
  "Rows Removed by Index Recheck"?: number;
  Plans?: PlanNode[];
}

interface Sent {
  query: string;
  params: string;
}

const capture = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
const sent: Sent[] = [];

capture.$on("query", (event) => {
  sent.push({ query: event.query, params: event.params });
});

async function capturing(run: () => Promise<unknown>): Promise<Sent[]> {
  sent.length = 0;
  await run();
  return [...sent];
}

/** Today of the fixture's companies (default zone), not the runner's day. */
function today(): BusinessDayRange {
  return businessDayRange(new Date(), DEFAULT_BUSINESS_TIMEZONE);
}

function startOfToday(): Date {
  return today().start;
}

async function seedBusiness(id: string, shipperId: string): Promise<void> {
  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${id.slice(-1)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(53000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `history-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.shipper.create({
    data: { id: shipperId, name: "Embarcador", businessId: id },
  });
}

beforeAll(async () => {
  await seedBusiness(HISTORY, HISTORY_SHIPPER);
  await seedBusiness(SMALL, SMALL_SHIPPER);

  const midnight = startOfToday();

  /**
   * The history: everything before today's midnight, one delivery every
   * fifteen minutes going back. One in fifty failed, the rest delivered half
   * an hour after being created.
   */
  await prisma.$executeRawUnsafe(
    `
    INSERT INTO delivery (
      id, recipient_name, city, uf, street, status, "businessId", "shipperId",
      kind, created_at, updated_at, delivered_at
    )
    SELECT
      gen_random_uuid()::text, 'Cliente ' || n, 'São Paulo', 'SP', 'Rua ' || n,
      (CASE WHEN n % 50 = 0 THEN 'FAILED' ELSE 'DELIVERED' END)::"DeliveryStatus",
      $1, $2, 'DELIVERY'::"DeliveryKind",
      at - interval '30 minutes',
      at,
      CASE WHEN n % 50 = 0 THEN NULL ELSE at END
    FROM (
      SELECT n, ($3::timestamptz AT TIME ZONE 'UTC') - (n * 15 || ' minutes')::interval AS at
      FROM generate_series(1, ${HISTORY_VOLUME}) AS n
    ) AS history
    `,
    HISTORY,
    HISTORY_SHIPPER,
    midnight,
  );

  // Today, as a dispatcher sees it: a few dozen open, a handful finished.
  const today = [
    ...Array.from({ length: OPEN_PENDING }, () => ({ status: "PENDING" as const })),
    ...Array.from({ length: OPEN_IN_TRANSIT }, () => ({ status: "IN_TRANSIT" as const })),
    ...Array.from({ length: DELIVERED_TODAY }, () => ({
      status: "DELIVERED" as const,
      delivered_at: new Date(),
    })),
    ...Array.from({ length: FAILED_TODAY }, () => ({ status: "FAILED" as const })),
  ];

  await prisma.delivery.createMany({
    data: today.map((row, index) => ({
      ...row,
      businessId: HISTORY,
      shipperId: HISTORY_SHIPPER,
      recipient_name: `Hoje ${index}`,
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
    })),
  });

  /**
   * The small carrier. Its rows come in PAIRS sharing a created_at, so every
   * export batch boundary falls between two rows the timestamp alone cannot
   * order — the tie a keyset has to break without losing or repeating one.
   */
  await prisma.$executeRawUnsafe(
    `
    INSERT INTO delivery (
      id, recipient_name, city, uf, street, status, "businessId", "shipperId",
      kind, created_at, updated_at
    )
    SELECT
      gen_random_uuid()::text, 'Pequena ' || n, 'Campinas', 'SP', 'Rua ' || n,
      'PENDING'::"DeliveryStatus", $1, $2, 'DELIVERY'::"DeliveryKind",
      now() - ((n / 2) || ' minutes')::interval,
      now()
    FROM generate_series(1, ${SMALL_VOLUME}) AS n
    `,
    SMALL,
    SMALL_SHIPPER,
  );

  await prisma.user.create({
    data: {
      id: REPORTER,
      name: "Motorista Histórico",
      email: `historico-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: HISTORY,
    },
  });

  await prisma.occurrenceType.createMany({
    data: [
      { id: HISTORY_TYPE, name: "Ausente", businessId: HISTORY },
      { id: SMALL_TYPE, name: "Ausente", businessId: SMALL },
    ],
  });

  // One occurrence per delivery, in both companies, at the delivery's time.
  await prisma.$executeRawUnsafe(
    `
    INSERT INTO delivery_occurrence (
      id, "deliveryId", "businessId", "occurrenceTypeId", "reportedById",
      created_at, updated_at
    )
    SELECT gen_random_uuid()::text, d.id, d."businessId",
           CASE WHEN d."businessId" = $1 THEN $3 ELSE $4 END,
           $5, d.created_at, d.created_at
    FROM delivery d
    WHERE d."businessId" IN ($1, $2)
    `,
    HISTORY,
    SMALL,
    HISTORY_TYPE,
    SMALL_TYPE,
    REPORTER,
  );

  await prisma.$executeRawUnsafe('ANALYZE "delivery"');
  await prisma.$executeRawUnsafe('ANALYZE "delivery_occurrence"');
}, 300_000);

afterAll(async () => {
  await prisma.deliveryOccurrence.deleteMany({
    where: { businessId: { in: [HISTORY, SMALL] } },
  });
  await prisma.delivery.deleteMany({
    where: { businessId: { in: [HISTORY, SMALL] } },
  });

  await capture.$disconnect();
  await prisma.$disconnect();
}, 180_000);

function flatten(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flatten)];
}

function indexesUsed(plan: PlanNode): string[] {
  return flatten(plan)
    .map((node) => node["Index Name"])
    .filter((name): name is string => Boolean(name));
}

/**
 * Every row a scan of `table` produced or threw away, over all its loops.
 *
 * "Actual Rows" alone is what survived the filter, so a scan that reads sixty
 * thousand rows to keep ten reports ten. The discarded ones are the cost.
 */
function rowsTouched(plan: PlanNode, table: string): number {
  return flatten(plan)
    .filter((node) => node["Relation Name"] === table)
    .reduce((sum, node) => {
      const perLoop =
        (node["Actual Rows"] ?? 0) +
        (node["Rows Removed by Filter"] ?? 0) +
        (node["Rows Removed by Index Recheck"] ?? 0);

      return sum + perLoop * (node["Actual Loops"] ?? 1);
    }, 0);
}

function parsePlan(raw: unknown): PlanNode {
  const parsed = (typeof raw === "string" ? JSON.parse(raw) : raw) as Array<{
    Plan: PlanNode;
  }>;

  return parsed[0].Plan;
}

/** Prisma logs a date as "2026-09-24 03:00:00.000 UTC". */
const LOGGED_DATE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/;

/** The plan with the logged values bound, as the first executions get. */
async function boundPlanOf(statement: Sent): Promise<PlanNode> {
  const params = JSON.parse(statement.params) as unknown[];

  // Re-sent as text, a logged date would not compare with a timestamp column;
  // its placeholders get the type back (without matching `$1` inside `$10`).
  let sql = statement.query;

  params.forEach((value, index) => {
    if (typeof value === "string" && LOGGED_DATE.test(value)) {
      sql = sql.replace(
        new RegExp(`\\$${index + 1}(?!\\d)(?!::)`, "g"),
        `$${index + 1}::timestamptz`,
      );
    }
  });

  const rows = await prisma.$queryRawUnsafe<{ "QUERY PLAN": unknown }[]>(
    `EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`,
    ...params,
  );

  return parsePlan(rows[0]["QUERY PLAN"]);
}

function literal(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" || typeof value === "boolean") return String(value);

  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * The generic plan: prepared once, planned without looking at the values.
 *
 * Postgres moves a prepared statement to this plan after five executions when
 * it does not look worse on average, and Prisma prepares every statement it
 * sends. The parameter types are left for Postgres to infer from the query,
 * the same way it infers them for Prisma.
 */
async function genericPlanOf(statement: Sent): Promise<PlanNode> {
  const params = JSON.parse(statement.params) as unknown[];
  const name = `probe_${randomUUID().replace(/-/g, "")}`;

  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL plan_cache_mode = force_generic_plan`);
    await tx.$executeRawUnsafe(`PREPARE ${name} AS ${statement.query}`);

    try {
      const rows = await tx.$queryRawUnsafe<{ "QUERY PLAN": unknown }[]>(
        `EXPLAIN (ANALYZE, FORMAT JSON) EXECUTE ${name}(${params.map(literal).join(", ")})`,
      );

      return parsePlan(rows[0]["QUERY PLAN"]);
    } finally {
      await tx.$executeRawUnsafe(`DEALLOCATE ${name}`);
    }
  });
}

/** The statements of a capture that read `table` as their main relation. */
function reading(statements: Sent[], table: string): Sent[] {
  const from = new RegExp(`FROM\\s+("public"\\.)?"${table}"(\\s|$)`);
  return statements.filter((statement) => from.test(statement.query));
}

describe("the fixture has a history", () => {
  it("is mostly old, finished work", async () => {
    const old = await prisma.delivery.count({
      where: { businessId: HISTORY, created_at: { lt: startOfToday() } },
    });

    expect(old).toBe(HISTORY_VOLUME);
  });
});

describe("the operations summary reads today's rows, not the history", () => {
  let statements: Sent[] = [];

  beforeAll(async () => {
    statements = reading(
      await capturing(() =>
        readOperationSummary(
          {
            operation: new OperationDayRepository(capture),
            delivery: new DeliveryRepository(capture),
          },
          HISTORY,
          operationDay(DEFAULT_BUSINESS_TIMEZONE, new Date()),
        ),
      ),
      "delivery",
    );
  });

  it("still gives the right numbers", async () => {
    const summary = await readOperationSummary(
      {
        operation: new OperationDayRepository(prisma),
        delivery: new DeliveryRepository(prisma),
      },
      HISTORY,
      operationDay(DEFAULT_BUSINESS_TIMEZONE, new Date()),
    );

    expect(summary.totals).toMatchObject({
      unassigned: OPEN_PENDING,
      deliveredToday: DELIVERED_TODAY,
      failedToday: FAILED_TODAY,
    });
  });

  it("with the values bound", async () => {
    expect(statements.length).toBeGreaterThan(0);

    for (const statement of statements) {
      const plan = await boundPlanOf(statement);
      const touched = rowsTouched(plan, "delivery");

      expect(
        touched,
        `leu ${touched} entregas para um dia com ${OPEN_PENDING + OPEN_IN_TRANSIT + DELIVERED_TODAY + FAILED_TODAY}:\n${statement.query}`,
      ).toBeLessThan(2_000);
    }
  });

  it("and as the generic plan a reused statement gets", async () => {
    const used = new Set<string>();

    for (const statement of statements) {
      const plan = await genericPlanOf(statement);
      const touched = rowsTouched(plan, "delivery");

      indexesUsed(plan).forEach((name) => used.add(name));

      expect(
        touched,
        `o plano genérico leu ${touched} entregas:\n${statement.query}`,
      ).toBeLessThan(2_000);
    }

    // The partial indexes are what make "today" cheap; the literal statuses
    // are what let a generic plan use them.
    expect([...used]).toEqual(
      expect.arrayContaining(["delivery_delivered_today_idx", "delivery_failed_recent_idx"]),
    );
  });

  it("which the parameterised form it replaced could not do", async () => {
    /**
     * The control. This is what the summary used to send for "delivered
     * today": Prisma binds the status as a parameter. Bound, the planner sees
     * 'DELIVERED' and can use the partial index; generic, it cannot prove the
     * index covers the row, and walks every DELIVERED row the company has.
     * If this stops being expensive, the assertions above stop proving
     * anything about the literals.
     */
    const [statement] = reading(
      await capturing(() =>
        capture.delivery.count({
          where: {
            businessId: HISTORY,
            status: "DELIVERED",
            delivered_at: { gte: startOfToday() },
          },
        }),
      ),
      "delivery",
    );

    const touched = rowsTouched(await genericPlanOf(statement), "delivery");

    expect(touched).toBeGreaterThan(HISTORY_VOLUME / 2);
  });
});

describe("the listing's search stays inside the company", () => {
  /**
   * The search is an OR of ILIKEs over eight columns and the driver's name,
   * which no index serves. What must hold is that it is still filtered by
   * company FIRST: a small carrier searching next to a big one reads its own
   * rows, never the neighbour's forty thousand.
   */
  it("for the page and for its count", async () => {
    const statements = reading(
      await capturing(() =>
        new DeliveryRepository(capture).listDeliveries({
          page: 1,
          pageSize: 10,
          businessId: SMALL,
          search: "Pequena 1",
        }),
      ),
      "delivery",
    );

    expect(statements.length).toBeGreaterThanOrEqual(2);

    for (const statement of statements) {
      const plan = await boundPlanOf(statement);
      const touched = rowsTouched(plan, "delivery");

      expect(
        flatten(plan).some(
          (node) =>
            node["Node Type"] === "Seq Scan" && node["Relation Name"] === "delivery",
        ),
        `a busca varreu a tabela:\n${statement.query}`,
      ).toBe(false);

      expect(
        touched,
        `a busca leu ${touched} entregas numa empresa de ${SMALL_VOLUME}:\n${statement.query}`,
      ).toBeLessThan(SMALL_VOLUME * 1.1);
    }
  });
});

describe("the export reads what it writes", () => {
  async function exported(
    run: () => AsyncGenerator<Record<string, unknown>>,
  ): Promise<{ ids: string[]; statements: Sent[] }> {
    const ids: string[] = [];

    const statements = await capturing(async () => {
      for await (const row of run()) ids.push(row.id as string);
    });

    return { ids, statements };
  }

  /** The main query of each batch: the table's own read, paged. */
  function batches(statements: Sent[], table: string): Sent[] {
    return reading(statements, table).filter(
      (statement) =>
        /ORDER BY/.test(statement.query) && /LIMIT/.test(statement.query),
    );
  }

  it("deliveries: every row once, across ties at the batch boundary", async () => {
    const { ids } = await exported(() =>
      new DeliveryRepository(capture).streamDeliveriesForExport({ businessId: SMALL }),
    );

    expect(ids).toHaveLength(SMALL_VOLUME);
    expect(new Set(ids).size).toBe(SMALL_VOLUME);
  });

  it("deliveries: a later batch costs a batch, not the company or the table", async () => {
    const { statements } = await exported(() =>
      new DeliveryRepository(capture).streamDeliveriesForExport({ businessId: SMALL }),
    );

    const later = batches(statements, "delivery")[2];
    expect(later, "a exportação não passou do segundo lote").toBeDefined();

    for (const plan of [await boundPlanOf(later), await genericPlanOf(later)]) {
      const touched = rowsTouched(plan, "delivery");

      expect(touched, `um lote de 1000 leu ${touched} entregas:\n${later.query}`).toBeLessThan(
        2_000,
      );
    }
  });

  it("occurrences: every row once", async () => {
    const { ids } = await exported(() =>
      new DeliveryRepository(capture).streamOccurrencesForExport({ businessId: SMALL }),
    );

    expect(ids).toHaveLength(SMALL_VOLUME);
    expect(new Set(ids).size).toBe(SMALL_VOLUME);
  });

  it("occurrences: a later batch costs a batch", async () => {
    const { statements } = await exported(() =>
      new DeliveryRepository(capture).streamOccurrencesForExport({ businessId: SMALL }),
    );

    const later = batches(statements, "delivery_occurrence")[2];
    expect(later, "a exportação não passou do segundo lote").toBeDefined();

    for (const plan of [await boundPlanOf(later), await genericPlanOf(later)]) {
      const touched = rowsTouched(plan, "delivery_occurrence");

      expect(
        touched,
        `um lote de 1000 leu ${touched} ocorrências:\n${later.query}`,
      ).toBeLessThan(2_000);
    }
  });
});
