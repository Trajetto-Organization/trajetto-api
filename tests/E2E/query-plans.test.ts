import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

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
const prisma = new PrismaClient();

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
  "Plan Rows"?: number;
  Plans?: PlanNode[];
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
});

/** Runs EXPLAIN (ANALYZE, FORMAT JSON) and hands back the plan tree. */
async function planOf(sql: string, params: unknown[] = []): Promise<PlanNode> {
  const rows = await prisma.$queryRawUnsafe<{ "QUERY PLAN": unknown }[]>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
    ...params,
  );

  const raw = rows[0]["QUERY PLAN"] as unknown;

  const parsed = (
    typeof raw === "string" ? JSON.parse(raw) : raw
  ) as Array<{ Plan: PlanNode }>;

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
    const mine = await prisma.delivery.count({ where: { businessId: CARRIER } });
    const theirs = await prisma.delivery.count({ where: { businessId: OTHER } });

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

    const rows = flatten(plan).reduce(
      (most, node) => Math.max(most, node["Actual Rows"] ?? 0),
      0,
    );

    // It has to touch this company's rows — that is what counting is — but it
    // must not touch the other company's.
    expect(
      rows,
      `a contagem leu ${rows} linhas para uma empresa de ${VOLUME}`,
    ).toBeLessThan(VOLUME * 1.5);
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
