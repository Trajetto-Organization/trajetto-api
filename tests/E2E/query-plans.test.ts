import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import {
  DEFAULT_BUSINESS_TIMEZONE,
  shiftDateKey,
} from "@/shared/time/business-day";
import { createPrismaClient } from "@/shared/database/database-client";
import {
  routeDaysOfOperationDay,
  type RouteListPeriodDays,
  type RoutePeriodDays,
} from "@/shared/route/route-period";

/**
 * What Postgres actually does with the queries the product runs most.
 *
 * An index in `schema.prisma` is a promise, not a plan. The planner decides
 * per query, and it stops using an index the moment a filter is written in a
 * way it cannot push down — a `LOWER()` on the left-hand side, a leading
 * wildcard, a sort on a column the index does not carry. None of that fails a
 * test, none of it fails a review, and none of it is visible until a customer
 * with real volume arrives: on the two hundred rows a test fixture holds, a
 * sequential scan IS the fastest plan, and the planner is right to pick it.
 *
 * So this seeds volume first — tens of thousands of deliveries across two
 * companies — and then asks Postgres what it intends to do. `EXPLAIN ANALYZE`,
 * not `EXPLAIN`: the row counts it reports are what say whether the estimate
 * and reality agree.
 *
 * The assertions are about ACCESS PATH, never about milliseconds. A test that
 * fails when the machine is busy teaches people to re-run it.
 */
const prisma = createPrismaClient();

const CARRIER = "018fda00-0000-7000-8000-00000000000a";
const OTHER = "018fda00-0000-7000-8000-00000000000b";

const SHIPPER = "018fda00-0000-7000-8000-0000000000s1";
const OTHER_SHIPPER = "018fda00-0000-7000-8000-0000000000s2";

/**
 * Enough rows that a sequential scan stops being the cheapest plan.
 *
 * Thirty thousand is roughly a mid-sized carrier's half-year, and well past
 * the point where Postgres prefers an index for a ten-row page. Below about
 * five thousand the planner reads the whole table and is right to.
 */
const VOLUME = 30_000;

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  "Rows Removed by Filter"?: number;
  "Plan Rows"?: number;
  "Index Cond"?: string;
  "Recheck Cond"?: string;
  Filter?: string;
  Plans?: PlanNode[];
}

/**
 * Every row the scans of `table` produced or threw away, over all loops.
 *
 * "Actual Rows" alone is counted AFTER the filter, so a sequential scan over
 * both companies that keeps one company's rows reports exactly that company's
 * size. The rows it read and discarded are "Rows Removed by Filter" — and
 * they are the cost.
 */
function rowsTouched(plan: PlanNode, table: string): number {
  return flatten(plan)
    .filter((node) => node["Relation Name"] === table)
    .reduce(
      (sum, node) =>
        sum +
        ((node["Actual Rows"] ?? 0) + (node["Rows Removed by Filter"] ?? 0)) *
          (node["Actual Loops"] ?? 1),
      0,
    );
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
      cnpj: String(52000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `plans-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.shipper.create({
    data: { id: shipperId, name: "Embarcador", businessId: id },
  });
}

beforeAll(async () => {
  await seedBusiness(CARRIER, SHIPPER);
  await seedBusiness(OTHER, OTHER_SHIPPER);

  /**
   * Inserted in one statement, on purpose.
   *
   * Thirty thousand rows through Prisma is a minute of round trips; through
   * `generate_series` it is under a second, and what is being tested is the
   * planner, not the ORM's insert path.
   *
   * The dates are spread over a year so `created_at DESC` is a real ordering
   * and not thirty thousand rows sharing one timestamp — which would let any
   * plan look good.
   */
  for (const [businessId, shipperId] of [
    [CARRIER, SHIPPER],
    [OTHER, OTHER_SHIPPER],
  ]) {
    await prisma.$executeRawUnsafe(
      `
      INSERT INTO delivery (
        id, recipient_name, city, uf, street, status,
        "businessId", "shipperId", kind, created_at, updated_at
      )
      SELECT
        gen_random_uuid()::text,
        'Cliente ' || n,
        'São Paulo',
        'SP',
        'Rua ' || n,
        (ARRAY['PENDING','IN_TRANSIT','DELIVERED','FAILED'])[1 + (n % 4)]::"DeliveryStatus",
        $1,
        $2,
        'DELIVERY'::"DeliveryKind",
        now() - (n || ' minutes')::interval,
        now()
      FROM generate_series(1, ${VOLUME}) AS n
      `,
      businessId,
      shipperId,
    );
  }

  // Without this the planner is working from the statistics of an empty
  // table and will choose a sequential scan however many rows are there.
  await prisma.$executeRawUnsafe('ANALYZE "delivery"');
}, 300_000);

afterAll(async () => {
  await prisma.delivery.deleteMany({
    where: { businessId: { in: [CARRIER, OTHER] } },
  });

  await prisma.shipper.deleteMany({
    where: { id: { in: [SHIPPER, OTHER_SHIPPER] } },
  });

  await prisma.business.deleteMany({ where: { id: { in: [CARRIER, OTHER] } } });

  await prisma.$disconnect();

  // The deliveries cascade into their events and occurrences: a few hundred
  // thousand rows, well past the default ten seconds.
}, 180_000);

/** Runs EXPLAIN (ANALYZE, FORMAT JSON) and hands back the plan tree. */
async function planOf(sql: string, params: unknown[] = []): Promise<PlanNode> {
  const rows = await prisma.$queryRawUnsafe<{ "QUERY PLAN": unknown }[]>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
    ...params,
  );

  const raw = rows[0]["QUERY PLAN"] as unknown;

  const parsed = (typeof raw === "string" ? JSON.parse(raw) : raw) as Array<{
    Plan: PlanNode;
  }>;

  return parsed[0].Plan;
}

function flatten(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flatten)];
}

function nodeTypes(plan: PlanNode): string[] {
  return flatten(plan).map((node) => node["Node Type"]);
}

function indexesUsed(plan: PlanNode): string[] {
  return flatten(plan)
    .map((node) => node["Index Name"])
    .filter((name): name is string => Boolean(name));
}

/** A sequential scan over one of the big tables, which is the thing to avoid. */
function scansSequentially(plan: PlanNode, table: string): boolean {
  return flatten(plan).some(
    (node) =>
      node["Node Type"] === "Seq Scan" && node["Relation Name"] === table,
  );
}

describe("the fixture is big enough to mean anything", () => {
  it("has volume, and it is spread across two companies", async () => {
    /**
     * The guard the rest of this file rests on. With a small table the planner
     * reads all of it and is RIGHT to — so every assertion below would pass or
     * fail for reasons that have nothing to do with the query.
     */
    const mine = await prisma.delivery.count({
      where: { businessId: CARRIER },
    });
    const theirs = await prisma.delivery.count({
      where: { businessId: OTHER },
    });

    expect(mine).toBe(VOLUME);
    expect(theirs).toBe(VOLUME);
  });
});

describe("the deliveries listing", () => {
  it("reaches page one through an index, not a scan", async () => {
    /**
     * The query behind the table a dispatcher opens all day: their company,
     * newest first, ten at a time. `(businessId, created_at)` exists for
     * exactly this, and the planner has to actually use it.
     */
    const plan = await planOf(
      `SELECT * FROM delivery WHERE "businessId" = $1
       ORDER BY created_at DESC LIMIT 10`,
      [CARRIER],
    );

    expect(
      scansSequentially(plan, "delivery"),
      `a listagem varre a tabela inteira: ${nodeTypes(plan).join(" → ")}`,
    ).toBe(false);

    expect(
      indexesUsed(plan).some((name) => name.includes("businessId_created_at")),
      `índice esperado não usado; usados: ${indexesUsed(plan).join(", ")}`,
    ).toBe(true);
  });

  it("and reads about ten rows to answer with ten", async () => {
    /**
     * The other half of the same question, and the one an index name cannot
     * answer. A plan can use an index, sort sixty thousand rows and then take
     * ten — which is a scan wearing an index's name. What says otherwise is
     * how many rows the scan actually produced.
     */
    const plan = await planOf(
      `SELECT * FROM delivery WHERE "businessId" = $1
       ORDER BY created_at DESC LIMIT 10`,
      [CARRIER],
    );

    const scanned = flatten(plan)
      .filter((node) => node["Node Type"].includes("Index"))
      .reduce((most, node) => Math.max(most, node["Actual Rows"] ?? 0), 0);

    expect(
      scanned,
      `a primeira página leu ${scanned} linhas para devolver 10`,
    ).toBeLessThan(200);
  });

  it("filtered by status, still through an index", async () => {
    const plan = await planOf(
      `SELECT * FROM delivery WHERE "businessId" = $1 AND status = 'PENDING'
       ORDER BY created_at DESC LIMIT 10`,
      [CARRIER],
    );

    expect(
      scansSequentially(plan, "delivery"),
      `o filtro por status varre a tabela: ${nodeTypes(plan).join(" → ")}`,
    ).toBe(false);

    // `(businessId, status, created_at)` exists precisely so this does not
    // have to sort.
    expect(
      indexesUsed(plan).some((name) => name.includes("status")),
      `índice de status não usado; usados: ${indexesUsed(plan).join(", ")}`,
    ).toBe(true);
  });

  it("and the count beside it stays inside one company", async () => {
    /**
     * The count runs with the same WHERE as the page, and it is the half
     * people forget: a listing that pages beautifully and counts by scanning
     * the table is still a table scan per request.
     */
    const plan = await planOf(
      `SELECT count(*) FROM delivery WHERE "businessId" = $1`,
      [CARRIER],
    );

    // It has to touch this company's rows — that is what counting is — but it
    // must not touch the other company's. The criterion used to be the
    // largest "Actual Rows" under 1.5 × VOLUME, which a sequential scan of
    // both companies also met: it reports the rows it KEPT.
    expect(
      scansSequentially(plan, "delivery"),
      `a contagem varre a tabela: ${nodeTypes(plan).join(" → ")}`,
    ).toBe(false);

    const touched = rowsTouched(plan, "delivery");

    expect(
      touched,
      `a contagem leu ${touched} linhas para uma empresa de ${VOLUME}`,
    ).toBeLessThan(VOLUME * 1.1);
  });

  it("and that criterion would notice a scan of both companies", async () => {
    /**
     * The control: the same count with every index path switched off. If
     * this ever passed the criterion above, the criterion would be as empty
     * as the one it replaced.
     */
    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL enable_indexscan = off");
      await tx.$executeRawUnsafe("SET LOCAL enable_indexonlyscan = off");
      await tx.$executeRawUnsafe("SET LOCAL enable_bitmapscan = off");

      const rows = await tx.$queryRawUnsafe<{ "QUERY PLAN": unknown }[]>(
        `EXPLAIN (ANALYZE, FORMAT JSON) SELECT count(*) FROM delivery WHERE "businessId" = $1`,
        CARRIER,
      );

      const raw = rows[0]["QUERY PLAN"];

      return (
        (typeof raw === "string" ? JSON.parse(raw) : raw) as Array<{
          Plan: PlanNode;
        }>
      )[0].Plan;
    });

    expect(scansSequentially(plan, "delivery")).toBe(true);
    expect(rowsTouched(plan, "delivery")).toBeGreaterThanOrEqual(VOLUME * 2);
  });
});

describe("deep pagination, measured rather than assumed", () => {
  it("still uses the index a long way in", async () => {
    /**
     * Page two thousand. Offset pagination is the right default for this
     * product — a dispatcher filters and sorts, and cursor paging cannot
     * offer "page 37" — but it has a known shape: the index is still used and
     * the rows before the offset are still walked.
     *
     * This asserts the plan, and reports the cost, so the day somebody adds an
     * infinite-scrolling surface there is a number to decide with instead of
     * an opinion.
     */
    const plan = await planOf(
      `SELECT * FROM delivery WHERE "businessId" = $1
       ORDER BY created_at DESC LIMIT 10 OFFSET 20000`,
      [CARRIER],
    );

    expect(
      scansSequentially(plan, "delivery"),
      `a paginação profunda varre a tabela: ${nodeTypes(plan).join(" → ")}`,
    ).toBe(false);
  });

  it("and walks everything before the offset, which is the trade", async () => {
    const plan = await planOf(
      `SELECT * FROM delivery WHERE "businessId" = $1
       ORDER BY created_at DESC LIMIT 10 OFFSET 20000`,
      [CARRIER],
    );

    const scanned = flatten(plan)
      .filter((node) => node["Node Type"].includes("Index"))
      .reduce((most, node) => Math.max(most, node["Actual Rows"] ?? 0), 0);

    /*
      Twenty thousand and ten rows to hand back ten. That is not a defect —
      it is what OFFSET means — and writing it down is the point: a surface
      that pages this deep, in a loop, is the one that needs a cursor.
    */
    expect(scanned).toBeGreaterThan(20_000);
  });
});

describe("one company cannot make another one slow", () => {
  it("never reads the neighbour's rows", async () => {
    /**
     * Tenancy as a performance property, not only a security one. Every
     * listing in this product is filtered by company, and an index that does
     * not lead with `businessId` would have Postgres read both carriers and
     * discard half — so one customer's growth would slow every other
     * customer's screens down.
     */
    const plan = await planOf(
      `SELECT * FROM delivery WHERE "businessId" = $1
       ORDER BY created_at DESC LIMIT 10`,
      [CARRIER],
    );

    const scanned = flatten(plan).reduce(
      (most, node) => Math.max(most, node["Actual Rows"] ?? 0),
      0,
    );

    expect(
      scanned,
      `leu ${scanned} linhas, e só existem ${VOLUME} nesta empresa`,
    ).toBeLessThan(VOLUME);
  });
});

/**
 * The screens that read events and occurrences by tenant.
 *
 * The control tower refreshes every 30 seconds; the occurrence list and its
 * counters sit on the operations dashboard. Both tables used to know only
 * their delivery, so "this company's latest fifteen" joined every delivery the
 * company ever had and sorted all of their events to return fifteen — a cost
 * that grew with the whole history. The SQL measured here is captured from the
 * queries the code actually sends.
 */
describe("what the operations screens read by tenant", () => {
  const REPORTER = randomUUID();
  const TYPE_CARRIER = randomUUID();
  const TYPE_OTHER = randomUUID();

  const capture = createPrismaClient({
    log: [{ emit: "event", level: "query" }],
  });

  const sent: Array<{ query: string; params: string }> = [];

  capture.$on("query", (event) => {
    sent.push({ query: event.query, params: event.params });
  });

  async function capturing<T>(run: () => Promise<T>) {
    sent.length = 0;
    await run();
    return [...sent];
  }

  beforeAll(async () => {
    await prisma.user.create({
      data: {
        id: REPORTER,
        name: "Motorista Planos",
        email: `planos-${randomUUID()}@exemplo.com.br`,
        password: "nao-usado",
        role: "BUSINESS_ADMIN",
        businessId: CARRIER,
      },
    });

    await prisma.occurrenceType.createMany({
      data: [
        { id: TYPE_CARRIER, name: "Ausente", businessId: CARRIER },
        { id: TYPE_OTHER, name: "Ausente", businessId: OTHER },
      ],
    });

    // Two events and one occurrence per delivery, in both companies, at
    // times spread like the deliveries themselves.
    for (const type of ["ARRIVAL", "PROOF"]) {
      await prisma.$executeRawUnsafe(
        `
        INSERT INTO delivery_event (id, type, "deliveryId", "businessId", created_at)
        SELECT substr(k.h, 1, 8) || '-' || substr(k.h, 9, 4) || '-7' ||
                 substr(k.r, 1, 3) || '-8' || substr(k.r, 4, 3) || '-' || substr(k.r, 7, 12),
               '${type}'::"DeliveryEventType",
               d.id, d."businessId", d.created_at + interval '5 minutes'
        FROM delivery d
        -- A uuid v7 of the event's instant, as Prisma mints it: the trail is
        -- partitioned by month on its id (plano-escala F2-16).
        CROSS JOIN LATERAL (
          SELECT lpad(to_hex((extract(epoch FROM d.created_at + interval '5 minutes') * 1000)::bigint), 12, '0') AS h,
                 md5(random()::text || d.id) AS r
        ) AS k
        WHERE d."businessId" IN ($1, $2)
        `,
        CARRIER,
        OTHER,
      );
    }

    await prisma.$executeRawUnsafe(
      `
      INSERT INTO delivery_occurrence (
        id, "deliveryId", "businessId", "occurrenceTypeId", "reportedById",
        created_at, updated_at
      )
      SELECT gen_random_uuid()::text, d.id, d."businessId",
             CASE WHEN d."businessId" = $1 THEN $3 ELSE $4 END,
             $5, d.created_at + interval '10 minutes', now()
      FROM delivery d
      WHERE d."businessId" IN ($1, $2)
      `,
      CARRIER,
      OTHER,
      TYPE_CARRIER,
      TYPE_OTHER,
      REPORTER,
    );

    await prisma.$executeRawUnsafe('ANALYZE "delivery_event"');
    await prisma.$executeRawUnsafe('ANALYZE "delivery_occurrence"');
  }, 300_000);

  afterAll(async () => {
    await prisma.deliveryOccurrence.deleteMany({
      where: { deliveryId: { not: "" }, reportedById: REPORTER },
    });
    await prisma.occurrenceType.deleteMany({
      where: { id: { in: [TYPE_CARRIER, TYPE_OTHER] } },
    });
    await prisma.user.deleteMany({ where: { id: REPORTER } });

    await capture.$disconnect();
  }, 60_000);

  async function widestScan(query: { query: string; params: string }) {
    const params = JSON.parse(query.params) as unknown[];

    // Prisma sends dates typed; re-sent as text they would not compare with a
    // timestamp column, so their placeholders get the type back.
    let sql = query.query;

    params.forEach((value, index) => {
      // Prisma logs a date as "2026-09-23 16:42:00.550 UTC".
      if (
        typeof value === "string" &&
        /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(value)
      ) {
        const placeholder = `$${index + 1}`;

        sql = sql
          .split(placeholder)
          .map((part, at, parts) =>
            // `$1` must not also match the start of `$10`.
            at < parts.length - 1 && !/^\d/.test(parts[at + 1])
              ? `${part}${placeholder}::timestamptz`
              : at < parts.length - 1
                ? `${part}${placeholder}`
                : part,
          )
          .join("");
      }
    });

    const plan = await planOf(sql, params);

    return {
      plan,
      rows: flatten(plan).reduce(
        (most, node) => Math.max(most, node["Actual Rows"] ?? 0),
        0,
      ),
    };
  }

  it("answers the tower's latest events without reading the history", async () => {
    // The repository the tower reads, with the tower's arguments: today in
    // the company's zone, fifteen entries per source.
    const { OperationDayRepository } =
      await import("@/modules/route/repositories/operation-day-repository");
    const { operationDay } = await import("@/shared/route/operation-day-rules");

    const queries = await capturing(() =>
      new OperationDayRepository(capture).listFeed(
        CARRIER,
        operationDay(DEFAULT_BUSINESS_TIMEZONE, new Date()),
        15,
      ),
    );

    for (const table of ['"delivery_event"', '"delivery_occurrence"']) {
      const feed = queries.find(
        (entry) =>
          entry.query.includes(`FROM "public".${table}`) &&
          entry.query.includes("ORDER BY"),
      );
      expect(feed, table).toBeDefined();

      const { plan, rows } = await widestScan(feed!);

      expect(scansSequentially(plan, table.replace(/"/g, "")), table).toBe(
        false,
      );
      expect(
        rows,
        `a torre leu ${rows} linhas de ${table} para mostrar 15`,
      ).toBeLessThan(2_000);
    }
  });

  it("pages the occurrence list without reading the history", async () => {
    const { DeliveryRepository } =
      await import("@/modules/delivery/repositories/delivery-repository");

    const queries = await capturing(() =>
      new DeliveryRepository(capture).listOccurrences({
        page: 1,
        pageSize: 10,
        businessId: CARRIER,
      } as never),
    );

    const page = queries.find(
      (entry) =>
        entry.query.includes('"delivery_occurrence"') &&
        entry.query.includes("ORDER BY"),
    );
    expect(page).toBeDefined();

    const { rows } = await widestScan(page!);

    expect(rows, `a lista leu ${rows} linhas para mostrar 10`).toBeLessThan(
      200,
    );
  });

  it("counts today's occurrences from today's rows only", async () => {
    const { DeliveryRepository } =
      await import("@/modules/delivery/repositories/delivery-repository");
    const { operationDay } = await import("@/shared/route/operation-day-rules");

    const queries = await capturing(() =>
      new DeliveryRepository(capture).operationBacklog(
        CARRIER,
        operationDay(DEFAULT_BUSINESS_TIMEZONE, new Date()),
      ),
    );

    // The occurrences count, not the backlog statement beside it.
    const today = queries.find((entry) =>
      entry.query.includes('AS "occurrences"'),
    );
    expect(today).toBeDefined();

    const { rows } = await widestScan(today!);

    // Today holds a day's worth of the fixture (a delivery a minute), not the
    // company's thirty thousand.
    expect(rows, `leu ${rows} linhas para contar as de hoje`).toBeLessThan(
      5_000,
    );
  });
});

/**
 * What the tower and the monitoring boards read for the day (review of the
 * tower package: these statements had no plan coverage).
 *
 * The tower polls every 30 s in every open tab. Sixty days of routes, forty a
 * day, five stops each, sit in front of it: the day's reads must reach the
 * day's forty routes through route (businessId, status, scheduled_date), not
 * walk the company's history.
 */
describe("what the tower reads for the day", () => {
  const DRIVER_CARRIER = randomUUID();
  const DRIVER_OTHER = randomUUID();

  const ROUTE_DAYS = 60;
  const ROUTES_PER_DAY = 40;
  const STOPS_PER_ROUTE = 20;

  const capture = createPrismaClient({
    log: [{ emit: "event", level: "query" }],
  });

  const sent: Array<{ query: string; params: string }> = [];

  capture.$on("query", (event) => {
    sent.push({ query: event.query, params: event.params });
  });

  async function capturing<T>(run: () => Promise<T>) {
    sent.length = 0;
    await run();
    return [...sent];
  }

  /** EXPLAIN ANALYZE of a captured statement, its dates typed back. */
  async function explain(query: { query: string; params: string }) {
    const params = JSON.parse(query.params) as unknown[];

    let sql = query.query;

    params.forEach((value, index) => {
      if (
        typeof value === "string" &&
        /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(value)
      ) {
        const placeholder = `$${index + 1}`;

        sql = sql
          .split(placeholder)
          .map((part, at, parts) =>
            at < parts.length - 1 && !/^\d/.test(parts[at + 1])
              ? `${part}${placeholder}::timestamptz`
              : at < parts.length - 1
                ? `${part}${placeholder}`
                : part,
          )
          .join("");
      }
    });

    return planOf(sql, params);
  }

  beforeAll(async () => {
    for (const [id, businessId] of [
      [DRIVER_CARRIER, CARRIER],
      [DRIVER_OTHER, OTHER],
    ]) {
      await prisma.driver.create({
        data: {
          id,
          name: "Motorista Planos",
          birth_date: new Date("1990-01-01"),
          cnh: `cnh-${id.slice(-8)}`,
          cpf: `cpf-${id.slice(-8)}`,
          rg: `rg-${id.slice(-8)}`,
          cep: "01001000",
          city: "São Paulo",
          uf: "SP",
          street: "Rua",
          address_number: "1",
          status: "ACTIVE",
          contract_type: "OWNED",
          businessId,
        },
      });
    }

    for (const [businessId, driverId, idPrefix] of [
      [CARRIER, DRIVER_CARRIER, "018fdb0a-0000-7000-8000-"],
      [OTHER, DRIVER_OTHER, "018fdb0b-0000-7000-8000-"],
    ]) {
      // Today's routes are on the street or about to leave; every earlier
      // day's are done. The day is São Paulo's, as a date-only value. The
      // ids are time-ordered like the product's uuid(7), and each route's
      // stops are written together, as the product writes them: that is the
      // physical order the planner prices an index probe by.
      //
      // Today's running routes started today in São Paulo, at whatever hour
      // the suite runs: halfway since the company's midnight, at most six
      // hours ago. A flat "six hours ago" put them on the previous day from
      // 00:00 to 06:00 there (03:00-09:00 UTC), and the tower then counted
      // all of them as left open, not the two the tests move back.
      await prisma.$executeRawUnsafe(
        `
        INSERT INTO route (
          id, code, status, scheduled_date, started_at, completed_at,
          "businessId", "driverId", created_at, updated_at
        )
        SELECT
          $3 || lpad(to_hex(${ROUTE_DAYS * ROUTES_PER_DAY} - n + 1), 12, '0'),
          n,
          CASE WHEN (n - 1) / ${ROUTES_PER_DAY} = 0
               THEN (CASE WHEN n % 2 = 0 THEN 'IN_PROGRESS' ELSE 'RELEASED' END)
               ELSE 'COMPLETED' END::"RouteStatus",
          (now() AT TIME ZONE 'America/Sao_Paulo')::date - ((n - 1) / ${ROUTES_PER_DAY}),
          CASE WHEN (n - 1) / ${ROUTES_PER_DAY} = 0 AND n % 2 = 1 THEN NULL
               WHEN (n - 1) / ${ROUTES_PER_DAY} = 0
               THEN now() - LEAST(
                 interval '6 hours',
                 (now() - (((now() AT TIME ZONE 'America/Sao_Paulo')::date)::timestamp AT TIME ZONE 'America/Sao_Paulo')) / 2
               )
               ELSE now() - (((n - 1) / ${ROUTES_PER_DAY}) || ' days')::interval - interval '6 hours' END,
          CASE WHEN (n - 1) / ${ROUTES_PER_DAY} = 0 THEN NULL
               ELSE now() - (((n - 1) / ${ROUTES_PER_DAY}) || ' days')::interval - interval '1 hour' END,
          $1, $2, now(), now()
        FROM generate_series(1, ${ROUTE_DAYS * ROUTES_PER_DAY}) AS n
        ORDER BY n DESC
        `,
        businessId,
        driverId,
        idPrefix,
      );

      // Twenty stops a route: today's open ones each on a delivery of its
      // own (one open stop per delivery is a constraint), the finished days'
      // cycling over the deliveries — 48.000 stops a company, the volume at
      // which reading them all stops being the cheap plan.
      await prisma.$executeRawUnsafe(
        `
        WITH r AS (
          SELECT id, status, row_number() OVER (ORDER BY code) AS rn
          FROM route WHERE "businessId" = $1
        ),
        d AS (
          SELECT id, row_number() OVER (ORDER BY created_at DESC, id) AS dn
          FROM delivery WHERE "businessId" = $1
        )
        INSERT INTO route_stop (id, sequence, status, "routeId", "deliveryId", created_at, updated_at)
        SELECT
          gen_random_uuid()::text,
          k,
          CASE WHEN r.status = 'COMPLETED' THEN 'COMPLETED' ELSE 'PENDING' END::"RouteStopStatus",
          r.id, d.id, now(), now()
        FROM r
        CROSS JOIN generate_series(1, ${STOPS_PER_ROUTE}) AS k
        JOIN d ON d.dn = ((r.rn - 1) * ${STOPS_PER_ROUTE} + k - 1) % ${VOLUME} + 1
        ORDER BY r.id, k
        `,
        businessId,
      );
    }

    await prisma.$executeRawUnsafe('ANALYZE "route"');
    await prisma.$executeRawUnsafe('ANALYZE "route_stop"');
  }, 300_000);

  afterAll(async () => {
    await prisma.routeStop.deleteMany({
      where: { route: { businessId: { in: [CARRIER, OTHER] } } },
    });
    await prisma.route.deleteMany({
      where: { businessId: { in: [CARRIER, OTHER] } },
    });
    await prisma.driver.deleteMany({
      where: { id: { in: [DRIVER_CARRIER, DRIVER_OTHER] } },
    });

    await capture.$disconnect();
  }, 120_000);

  const today = async () => {
    const { operationDay } = await import("@/shared/route/operation-day-rules");

    return operationDay(DEFAULT_BUSINESS_TIMEZONE, new Date());
  };

  const repository = async () => {
    const { OperationDayRepository } =
      await import("@/modules/route/repositories/operation-day-repository");

    return new OperationDayRepository(capture);
  };

  it("counts the day's documents from the day's routes, not the company's history", async () => {
    const operation = await repository();
    const day = await today();

    const queries = await capturing(() =>
      operation.countDayDeliveries(CARRIER, day),
    );

    const statement = queries.find((entry) =>
      entry.query.includes('"day_route"'),
    );
    expect(statement).toBeDefined();

    const plan = await explain(statement!);

    expect(scansSequentially(plan, "route")).toBe(false);
    expect(scansSequentially(plan, "route_stop")).toBe(false);

    const routes = rowsTouched(plan, "route");

    // The stops reached from the day's routes. The failure arm also probes
    // route_stop, by delivery, once per FAILED row: that is proportional to
    // the day's failures (every FAILED row of this fixture is "updated
    // today"), not to the route history, and is left out here.
    const stops = flatten(plan)
      .filter(
        (node) =>
          node["Relation Name"] === "route_stop" &&
          (node["Node Type"] === "Seq Scan" ||
            String(node["Index Cond"] ?? node["Recheck Cond"] ?? "").includes(
              '"routeId"',
            )),
      )
      .reduce(
        (sum, node) =>
          sum +
          ((node["Actual Rows"] ?? 0) + (node["Rows Removed by Filter"] ?? 0)) *
            (node["Actual Loops"] ?? 1),
        0,
      );

    // Each FAILED row's facts are read once, not once per bound of its day.
    // The status is a filter on (deliveryId); (status, deliveryId), from
    // 20261007120000 until F2-21b dropped it, made it part of the
    // condition. Either way one probe.
    const failureProbes = flatten(plan).filter(
      (node) =>
        node["Relation Name"] === "route_stop" &&
        `${node.Filter ?? ""} ${node["Index Cond"] ?? ""}`.includes("FAILED"),
    );

    expect(failureProbes).toHaveLength(1);

    // Forty routes and eight hundred stops today, of 2.400 and 48.000.
    expect(routes, `leu ${routes} rotas para contar o dia`).toBeLessThan(
      ROUTES_PER_DAY * 5,
    );
    expect(stops, `leu ${stops} paradas para contar o dia`).toBeLessThan(
      ROUTES_PER_DAY * STOPS_PER_ROUTE * 2,
    );
  });

  /** A period of the routes (plan of 09/11/2026), N days back from today. */
  const routeDays = async (
    fromDaysAgo: number,
    toDaysAgo: number,
  ): Promise<RoutePeriodDays> => {
    const { date } = await today();

    return {
      from: shiftDateKey(date, -fromDaysAgo),
      to: shiftDateKey(date, -toDaysAgo),
      includesRunning: toDaysAgo === 0,
    };
  };

  it("pages the board by route from the day's routes", async () => {
    const operation = await repository();
    const day = await today();

    const queries = await capturing(() =>
      operation.listMonitoringRoutes(CARRIER, routeDaysOfOperationDay(day), {
        skip: 0,
        take: 20,
      }),
    );

    const page = queries.find((entry) => entry.query.includes("OVER ()"));
    expect(page).toBeDefined();

    const plan = await explain(page!);

    expect(scansSequentially(plan, "route")).toBe(false);

    const routes = rowsTouched(plan, "route");

    expect(routes, `leu ${routes} rotas para mostrar 20`).toBeLessThan(
      ROUTES_PER_DAY * 5,
    );
  });

  // The board's period (plan of 09/11/2026): a week of routes and the
  // running ones are a range of route (businessId, scheduled_date) and one
  // of (businessId, status, ...) — never the company's sixty days.
  it("pages the board over a week from the week's routes only", async () => {
    const operation = await repository();
    const week = await routeDays(6, 0);

    const queries = await capturing(() =>
      operation.listMonitoringRoutes(CARRIER, week, { skip: 0, take: 20 }),
    );

    const page = queries.find((entry) => entry.query.includes("OVER ()"));
    expect(page).toBeDefined();

    const plan = await explain(page!);

    expect(scansSequentially(plan, "route")).toBe(false);

    const routes = rowsTouched(plan, "route");

    // 280 routes in the week, of 2.400.
    expect(routes, `leu ${routes} rotas para uma semana`).toBeLessThan(
      ROUTES_PER_DAY * 7 * 2,
    );
  });

  // Wave 4, GET /route/live: the manager's phone polls it every 60 s while
  // the screen is focused. It must reach the live routes through route
  // (businessId, status, scheduled_date) — the running ones and today's
  // released ones, never the company's sixty days of history — and count
  // only those routes' stops, by route_stop (routeId, status), in the same
  // statement. No delivery, no event, no position history.
  it("lists the live routes from their own index ranges and counts only their stops", async () => {
    const operation = await repository();
    const day = await today();

    const queries = await capturing(() =>
      operation.listLiveRoutes(CARRIER, { date: day.date, take: 501 }),
    );

    expect(queries).toHaveLength(1);

    const statement = queries[0];
    expect(statement.query).toContain('"live"');

    const plan = await explain(statement);

    // Access path, not index names: the planner may reach the stops by
    // (routeId, status) or by the (routeId, sequence) unique key, and either
    // is a probe per live route. What it must never do is scan.
    expect(scansSequentially(plan, "route")).toBe(false);
    expect(scansSequentially(plan, "route_stop")).toBe(false);

    const routes = rowsTouched(plan, "route");
    const stops = rowsTouched(plan, "route_stop");

    // Forty live routes today (twenty running, twenty released) of 2.400,
    // and their eight hundred stops of 48.000.
    expect(routes, `leu ${routes} rotas para listar as ao vivo`).toBeLessThan(
      ROUTES_PER_DAY * 5,
    );
    expect(stops, `leu ${stops} paradas para contar as ao vivo`).toBeLessThan(
      ROUTES_PER_DAY * STOPS_PER_ROUTE * 2,
    );

    for (const table of [
      "delivery",
      "delivery_event",
      "driver_position",
      "delivery_occurrence",
    ]) {
      expect(rowsTouched(plan, table), table).toBe(0);
    }
  });

  it("reads the day's route moves inside the lookback week", async () => {
    const operation = await repository();
    const day = await today();

    const queries = await capturing(() => operation.listFeed(CARRIER, day, 15));

    const moves = queries.find((entry) =>
      entry.query.includes("'ROUTE_STARTED'"),
    );
    expect(moves).toBeDefined();

    const plan = await explain(moves!);

    expect(scansSequentially(plan, "route")).toBe(false);

    const routes = rowsTouched(plan, "route");

    // At most a week and a day of routes per arm, never sixty days' worth.
    expect(routes, `leu ${routes} rotas para o feed`).toBeLessThan(
      ROUTES_PER_DAY * 8 * 3,
    );
  });

  // Plan of 02/11/2026, K14: the routes board's default page (newest first)
  // reads its twenty routes through route_businessId_created_at_idx instead
  // of sorting the company's history, and counts the page's stops by status
  // from the page's routes only — never the deliveries behind them.
  it("pages the routes board newest first by its index and counts only the page's stops", async () => {
    // The fixture writes every route in one statement (one created_at);
    // spread them like a real history, so the order means something.
    await prisma.$executeRawUnsafe(
      `UPDATE route SET created_at = now() - (code || ' minutes')::interval
       WHERE "businessId" IN ($1, $2)`,
      CARRIER,
      OTHER,
    );
    await prisma.$executeRawUnsafe('ANALYZE "route"');

    const { RouteRepository } =
      await import("@/modules/route/repositories/route-repository");
    const routes = new RouteRepository(capture as never);

    const queries = await capturing(() =>
      routes.listRoutes({ businessId: CARRIER, page: 1, pageSize: 20 }),
    );

    const page = queries.find(
      (entry) =>
        /FROM "public"\."route"/.test(entry.query) &&
        /ORDER BY/.test(entry.query) &&
        /LIMIT/.test(entry.query),
    );
    expect(page, queries.map((entry) => entry.query).join("\n")).toBeDefined();

    const pagePlan = await explain(page!);

    expect(scansSequentially(pagePlan, "route")).toBe(false);

    const read = rowsTouched(pagePlan, "route");

    expect(read, `leu ${read} rotas para mostrar 20`).toBeLessThan(200);

    const counted = queries.find(
      (entry) =>
        /FROM "public"\."route_stop"/.test(entry.query) &&
        /GROUP BY/.test(entry.query),
    );
    expect(counted).toBeDefined();

    const countPlan = await explain(counted!);

    expect(scansSequentially(countPlan, "route_stop")).toBe(false);

    const stops = rowsTouched(countPlan, "route_stop");

    expect(stops, `leu ${stops} paradas para contar 20 rotas`).toBeLessThan(
      20 * STOPS_PER_ROUTE * 2,
    );

    // No delivery is read for the board at all.
    expect(
      queries.some((entry) => /FROM "public"\."delivery"/.test(entry.query)),
    ).toBe(false);
  });

  // Plan of 09/11/2026: Rotas opens on Hoje. Its page, its cards and its
  // filter counts read the day's routes, the running ones and the earlier
  // days' routes that never left, never the company's history.
  /**
   * A real history's spread of created_at, as the K14 case writes it, so the
   * period's cases mean the same when they run alone.
   */
  const spreadRouteCreation = async () => {
    await prisma.$executeRawUnsafe(
      `UPDATE route SET created_at = now() - (code || ' minutes')::interval
       WHERE "businessId" IN ($1, $2)`,
      CARRIER,
      OTHER,
    );
    await prisma.$executeRawUnsafe('ANALYZE "route"');
  };

  /** The list's period: the tower's, with the overdue routes when it reaches today. */
  const listDays = async (
    fromDaysAgo: number,
    toDaysAgo: number,
  ): Promise<RouteListPeriodDays> => {
    const days = await routeDays(fromDaysAgo, toDaysAgo);

    return { ...days, includesOverdue: days.includesRunning };
  };

  it("lists and counts the routes of Hoje from the day's routes", async () => {
    await spreadRouteCreation();

    const { RouteRepository } =
      await import("@/modules/route/repositories/route-repository");
    const routes = new RouteRepository(capture as never);
    const period = await listDays(0, 0);

    const queries = await capturing(() =>
      routes.listRoutes({ businessId: CARRIER, page: 1, pageSize: 10, period }),
    );

    const reads = queries.filter(
      (entry) =>
        /FROM "public"\."route"/.test(entry.query) &&
        (/GROUP BY/.test(entry.query) ||
          /LIMIT/.test(entry.query) ||
          /MIN\(/.test(entry.query)),
    );

    // How far the forgotten routes reach, the page and the three counts
    // (status, driver, vehicle). Without the reach, the page went down
    // route (businessId, scheduled_date) past today's forty, through every
    // earlier day, looking for a running route that was not there.
    expect(
      reads.length,
      queries.map((entry) => entry.query).join("\n"),
    ).toBeGreaterThanOrEqual(5);

    for (const statement of reads) {
      const plan = await explain(statement);

      expect(scansSequentially(plan, "route")).toBe(false);

      const read = rowsTouched(plan, "route");

      // Forty routes today (twenty of them running), of 2.400.
      expect(read, `leu ${read} rotas para o dia`).toBeLessThan(
        ROUTES_PER_DAY * 5,
      );
    }

    expect(
      queries.some((entry) => /FROM "public"\."delivery"/.test(entry.query)),
    ).toBe(false);
  });

  // A custom week at the far end of the sixty days: the page and the counts
  // read that week's routes by the route (businessId, scheduled_date) range.
  // In newest-created order the page walked route (businessId, created_at
  // DESC) from today to reach its tenth row of the week — every route
  // created since, priced as if the week were spread over the history; by
  // the route's day (the order with a period) it is a range of the week.
  it("pages and counts a past custom week from that week's routes", async () => {
    await spreadRouteCreation();

    const { RouteRepository } =
      await import("@/modules/route/repositories/route-repository");
    const routes = new RouteRepository(capture as never);
    const period = await listDays(59, 53);

    const queries = await capturing(() =>
      routes.listRoutes({ businessId: CARRIER, page: 1, pageSize: 10, period }),
    );

    const counts = queries.filter(
      (entry) =>
        /FROM "public"\."route"/.test(entry.query) &&
        /GROUP BY/.test(entry.query),
    );

    expect(counts.length).toBe(3);

    for (const statement of counts) {
      const plan = await explain(statement);

      expect(scansSequentially(plan, "route")).toBe(false);

      const read = rowsTouched(plan, "route");

      // 280 routes in that week, of 2.400.
      expect(read, `leu ${read} rotas para contar a semana`).toBeLessThan(
        ROUTES_PER_DAY * 7 * 2,
      );
    }

    const page = queries.find(
      (entry) =>
        /FROM "public"\."route"/.test(entry.query) &&
        /ORDER BY/.test(entry.query) &&
        /LIMIT/.test(entry.query),
    );
    expect(page).toBeDefined();

    const pagePlan = await explain(page!);

    expect(scansSequentially(pagePlan, "route")).toBe(false);

    const read = rowsTouched(pagePlan, "route");

    // 280 routes in that week, of 2.400; the walk from today read 2.120.
    expect(read, `leu ${read} rotas para a página`).toBeLessThan(
      ROUTES_PER_DAY * 7 * 2,
    );
  });

  // Plan of 02/11/2026, H3: the deliveries list's "Em Rota" share on routes
  // left open runs on every listing. It must find those routes through the
  // route index and count only THEIR open stops — never every open stop of
  // the database grouped by route and joined afterwards.
  it("counts the list's share on routes left open from those routes' stops only", async () => {
    // Two of today's running routes left three days ago; the cutoff is
    // explicit, so the test does not depend on the hour it runs at.
    await prisma.$executeRawUnsafe(
      `UPDATE route SET started_at = now() - interval '3 days'
       WHERE "businessId" = $1 AND code IN (2, 4)`,
      CARRIER,
    );
    await prisma.$executeRawUnsafe('ANALYZE "route"');

    const { DeliveryRepository } =
      await import("@/modules/delivery/repositories/delivery-repository");
    const deliveries = new DeliveryRepository(capture as never);

    const leftOpenBefore = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

    const listed: {
      page?: Awaited<ReturnType<typeof deliveries.listDeliveries>>;
    } = {};

    const queries = await capturing(async () => {
      listed.page = await deliveries.listDeliveries({
        businessId: CARRIER,
        page: 1,
        pageSize: 10,
        leftOpenBefore,
      });
    });

    // Each route's twenty stops cycle over the four statuses of the
    // fixture's deliveries: five of them are IN_TRANSIT documents.
    expect(listed.page?.leftOpenRoutes?.map((route) => route.open)).toEqual([
      5, 5,
    ]);

    const sentList = queries.map((entry) => entry.query).join("\n");

    // The routes left open: the company's running routes by the index,
    // never its sixty days of history.
    const routesRead = queries.find(
      (entry) =>
        /FROM "public"\."route"\s/.test(entry.query) &&
        /"started_at"/.test(entry.query),
    );
    expect(routesRead, sentList).toBeDefined();

    const routesPlan = await explain(routesRead!);

    expect(
      scansSequentially(routesPlan, "route"),
      JSON.stringify(routesPlan),
    ).toBe(false);

    const routes = rowsTouched(routesPlan, "route");

    expect(routes, `leu ${routes} rotas para achar 2`).toBeLessThan(
      ROUTES_PER_DAY * 2,
    );

    // Their open stops, counted from those two routes alone.
    const stopsRead = queries.find(
      (entry) =>
        /FROM "public"\."route_stop"/.test(entry.query) &&
        /GROUP BY/.test(entry.query),
    );
    expect(stopsRead, sentList).toBeDefined();

    const stopsPlan = await explain(stopsRead!);

    expect(
      scansSequentially(stopsPlan, "route_stop"),
      JSON.stringify(stopsPlan),
    ).toBe(false);

    const stops = rowsTouched(stopsPlan, "route_stop");

    // Forty stops on the two routes left open, of the 1.600 open stops of
    // the two companies (and 96.000 stops in all).
    expect(stops, `leu ${stops} paradas para contar 2 rotas`).toBeLessThan(
      STOPS_PER_ROUTE * 2 * 4,
    );
  });

  it("tells the summary's inherited from the routes left open and their stops only", async () => {
    // GET /delivery/operation-summary, on every call, answers what its "Em
    // rota" inherited from routes left open (H3). It read the tower's whole
    // day for that (listTowerRoutes: the day's routes, the week's ended ones
    // and every stop of every running route) only to keep two of them.
    // Measured as the summary's extra rows over the numbers it already
    // reads: the cost of `inherited` alone.
    await prisma.$executeRawUnsafe(
      `UPDATE route SET started_at = now() - interval '3 days'
       WHERE "businessId" = $1 AND code IN (2, 4)`,
      CARRIER,
    );
    await prisma.$executeRawUnsafe('ANALYZE "route"');

    const { OperationSummaryUseCase } =
      await import("@/modules/delivery/usecases/operation-summary/operation-summary-usecase");
    const { readOperationSummary } =
      await import("@/modules/delivery/usecases/operation-summary/read-operation-summary");
    const { DeliveryRepository } =
      await import("@/modules/delivery/repositories/delivery-repository");
    const { inheritedFromRunningRoutes } =
      await import("@/shared/route/route-left-open");

    const operation = await repository();
    const delivery = new DeliveryRepository(capture as never);
    const manager = {
      findUserById: async () => ({
        id: "manager",
        role: "BUSINESS_ADMIN",
        businessId: CARRIER,
        driverId: null,
      }),
    };

    const summaryCase = new OperationSummaryUseCase(
      manager as never,
      delivery,
      operation,
    );

    /** Rows the route and route_stop scans of these statements touched. */
    async function routeRowsOf(
      queries: Array<{ query: string; params: string }>,
    ) {
      let total = 0;

      for (const query of queries) {
        if (!/FROM "public"\."route(_stop)?"/.test(query.query)) continue;

        const plan = await explain(query);

        total += rowsTouched(plan, "route") + rowsTouched(plan, "route_stop");
      }

      return total;
    }

    const day = await today();

    const numbersOnly = await routeRowsOf(
      await capturing(() =>
        readOperationSummary({ operation, delivery }, CARRIER, day),
      ),
    );

    const answered: {
      summary?: Awaited<ReturnType<typeof summaryCase.execute>>;
    } = {};

    const withInherited = await routeRowsOf(
      await capturing(async () => {
        answered.summary = await summaryCase.execute({
          userId: "manager",
          businessId: CARRIER,
        });
      }),
    );

    // The tower's own reading, for the same company and instant: the two
    // routes left open, their twenty open stops each.
    const now = new Date();
    const tower = inheritedFromRunningRoutes(
      (await operation.listTowerRoutes(CARRIER, day, now)).filter(
        (route) => route.status === "IN_PROGRESS",
      ),
      DEFAULT_BUSINESS_TIMEZONE,
      now,
    );

    expect(tower).toMatchObject({ routes: 2, deliveries: STOPS_PER_ROUTE * 2 });
    expect(answered.summary?.inherited).toEqual(tower);

    const inheritedCost = withInherited - numbersOnly;

    // Two routes and their forty stops, of the day's 40 routes, the week's
    // ended ones and the 440 stops of the running routes.
    expect(
      inheritedCost,
      `o herdado leu ${inheritedCost} linhas de rota e de parada para achar 2 rotas`,
    ).toBeLessThan(STOPS_PER_ROUTE * 2 * 4);
  });
});

describe("the MASTER's company list", () => {
  // The platform's companies, each with its fleet: 3.600 carriers is the
  // target (escala do Comprovei); 400 with 25 vehicles each (10.000 in all)
  // is already where reading every vehicle for a page of ten stops being
  // the cheap plan.
  const COMPANIES = 400;
  const VEHICLES_PER_COMPANY = 25;
  const PAGE_SIZE = 10;
  const PREFIX = "018fdc0c-0000-7000-8000-";

  const capture = createPrismaClient({
    log: [{ emit: "event", level: "query" }],
  });

  const sent: Array<{ query: string; params: string }> = [];

  capture.$on("query", (event) => {
    sent.push({ query: event.query, params: event.params });
  });

  beforeAll(async () => {
    // Newest first by created_at, like the list's default order; ids are
    // time-ordered like the product's uuid(7).
    await prisma.$executeRawUnsafe(
      `
      INSERT INTO business (
        id, corporate_reason, cep, city, uf, street, address_number, cnpj,
        cnae, responsible_name, telephone, email, created_at, updated_at
      )
      SELECT
        $1 || lpad(to_hex(n), 12, '0'),
        'Empresa Planos ' || n,
        '01001000', 'São Paulo', 'SP', 'Rua', '1',
        (63000000000000 + n)::text,
        '4930202', 'Responsável', '11999999999',
        'empresa-planos-' || n || '@exemplo.com.br',
        now() + (n || ' seconds')::interval,
        now()
      FROM generate_series(1, ${COMPANIES}) AS n
      `,
      PREFIX,
    );

    await prisma.$executeRawUnsafe(
      `
      INSERT INTO fuel_type (id, description, "businessId", created_at, updated_at)
      SELECT gen_random_uuid()::text, 'Diesel', id, now(), now()
      FROM business WHERE id LIKE $1 || '%'
      `,
      PREFIX,
    );

    // Every fifth vehicle INACTIVE: it frees its slot and is not counted.
    // Each company's fleet written together, as the product writes it.
    await prisma.$executeRawUnsafe(
      `
      INSERT INTO vehicle (
        id, description, license_plate, brand, model, acquisition_date,
        fleet_type, current_mileage, maintenance_interval_km,
        maintenance_interval_months, renavam, manufacturing_year, model_year,
        km_per_liter, number_of_axles, status, "businessId", "fuelTypeId",
        created_at, updated_at
      )
      SELECT
        gen_random_uuid()::text, 'Caminhão', 'PLN' || k, 'Volvo', 'FH',
        now(), 'OWNED'::"FleetType", 1000, 10000, 6, 'R' || k,
        now(), now(), 3, 3,
        CASE WHEN k % 5 = 0 THEN 'INACTIVE' ELSE 'ACTIVE' END::"VehicleStatus",
        f."businessId", f.id, now(), now()
      FROM fuel_type f
      CROSS JOIN generate_series(1, ${VEHICLES_PER_COMPANY}) AS k
      WHERE f."businessId" LIKE $1 || '%'
      ORDER BY f."businessId", k
      `,
      PREFIX,
    );

    await prisma.$executeRawUnsafe('ANALYZE "business"');
    await prisma.$executeRawUnsafe('ANALYZE "vehicle"');
  }, 300_000);

  afterAll(async () => {
    await prisma.vehicle.deleteMany({
      where: { businessId: { startsWith: PREFIX } },
    });
    await prisma.fuelType.deleteMany({
      where: { businessId: { startsWith: PREFIX } },
    });
    await prisma.business.deleteMany({
      where: { id: { startsWith: PREFIX } },
    });

    await capture.$disconnect();
  }, 120_000);

  it("counts the page's fleets from the page's vehicles, not the platform's", async () => {
    const { BusinessRepository } =
      await import("@/modules/business/repositories/business-repository");
    const businesses = new BusinessRepository(capture as never);

    sent.length = 0;

    const listed = await businesses.listBusiness({
      page: 1,
      pageSize: PAGE_SIZE,
      businessId: CARRIER,
      currentUserRole: "MASTER",
    });

    const queries = [...sent];

    // The newest ten companies, each with 20 vehicles that hold a slot.
    expect(listed.data).toHaveLength(PAGE_SIZE);
    expect(
      listed.data.map((business) => (business as { id: string }).id),
    ).toEqual(
      Array.from(
        { length: PAGE_SIZE },
        (_, index) =>
          `${PREFIX}${(COMPANIES - index).toString(16).padStart(12, "0")}`,
      ),
    );
    expect(
      listed.data.map(
        (business) => (business as { vehicle_count: number }).vehicle_count,
      ),
    ).toEqual(Array(PAGE_SIZE).fill((VEHICLES_PER_COMPANY * 4) / 5));

    const sentList = queries.map((entry) => entry.query).join("\n");

    const vehiclesRead = queries.filter((entry) =>
      /FROM "public"\."vehicle"/.test(entry.query),
    );

    expect(vehiclesRead.length, sentList).toBeGreaterThan(0);

    for (const read of vehiclesRead) {
      const plan = await planOf(
        read.query,
        JSON.parse(read.params) as unknown[],
      );

      expect(scansSequentially(plan, "vehicle"), JSON.stringify(plan)).toBe(
        false,
      );

      const vehicles = rowsTouched(plan, "vehicle");

      // Ten companies' 250 vehicles, of the platform's 10.000.
      expect(
        vehicles,
        `leu ${vehicles} veículos para contar a frota de ${PAGE_SIZE} empresas`,
      ).toBeLessThan(PAGE_SIZE * VEHICLES_PER_COMPANY * 2);
    }
  });
});
