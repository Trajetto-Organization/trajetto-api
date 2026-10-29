import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { DashboardRepository } from "@/modules/dashboard/repositories/dashboard-repository";
import {
  businessMonthStart,
  zonedWallTimeToUtc,
} from "@/shared/time/business-day";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The dashboard's counts are index range counts, not a label per row.
 *
 * The overview counted every row of the window and labelled each one in SQL
 * (two AT TIME ZONE, a date_trunc and a to_char) before grouping. Under the
 * load harness, on a tenant with 300k deliveries, that statement averaged
 * 298 ms and was a quarter of the database CPU at 120 req/s
 * (docs/desempenho/carga-2026-10.md). The buckets now come from the app and
 * the table is read once, each row filed by width_bucket over them. A range
 * count per bucket was the first take; it made a MASTER view (no tenant, and
 * no created_at-only index) scan each table once PER BUCKET, so the plan is
 * checked below for both scopes.
 *
 * The answer must be the one the per-row label gave: the reference below is
 * that old SQL, run here against the same rows, at month edges where UTC and
 * the company's zone disagree.
 */
const counted = createPrismaClient({
  log: [{ level: "query", emit: "event" }],
});
const prisma = createPrismaClient();

const statements: Array<{ query: string; params: string }> = [];

const CARRIER = "018fe700-0000-7000-8000-00000000000a";
const OTHER = "018fe700-0000-7000-8000-00000000000b";
const SP = "America/Sao_Paulo";

const repository = new DashboardRepository(counted as never);

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Actual Loops"?: number;
  Plans?: PlanNode[];
}

function flatten(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flatten)];
}

async function seedBusiness(id: string): Promise<void> {
  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${id}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(74000000000000 + Math.floor(Math.random() * 9_000_000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `faixas-${randomUUID()}@exemplo.com.br`,
    },
  });
}

/** The old statement: every row labelled by its month (or day) in the zone; no businessId = MASTER. */
async function perRowLabels(
  businessId: string | undefined,
  from: Date,
  to: Date,
  unit: "month" | "day" = "month",
): Promise<Record<string, number>> {
  const format = unit === "day" ? "YYYY-MM-DD" : "YYYY-MM";
  const rows = await prisma.$queryRaw<
    Array<{ period: string; count: bigint }>
  >(Prisma.sql`
    SELECT to_char(date_trunc(${unit}, ("created_at" AT TIME ZONE 'UTC') AT TIME ZONE ${SP}), ${format}) AS period,
           count(*)::bigint AS count
    FROM "public"."supplier"
    WHERE "created_at" >= (${from}::timestamptz AT TIME ZONE 'UTC')
      AND "created_at" < (${to}::timestamptz AT TIME ZONE 'UTC')
      ${businessId ? Prisma.sql`AND "businessId" = ${businessId}` : Prisma.empty}
    GROUP BY 1
  `);

  return Object.fromEntries(rows.map((row) => [row.period, Number(row.count)]));
}

beforeAll(async () => {
  counted.$on("query" as never, (event: { query: string; params: string }) => {
    statements.push({ query: event.query, params: event.params });
  });

  await seedBusiness(CARRIER);
  await seedBusiness(OTHER);

  // Rows on both sides of each São Paulo midnight that opens a month: 22:00
  // on the last day is already the next month in UTC, 00:30 on the first is
  // still the previous one in UTC.
  const instants = [
    zonedWallTimeToUtc(SP, 2026, 6, 15, 10),
    zonedWallTimeToUtc(SP, 2026, 6, 30, 22),
    zonedWallTimeToUtc(SP, 2026, 6, 30, 23, 59),
    zonedWallTimeToUtc(SP, 2026, 7, 1, 0, 30),
    zonedWallTimeToUtc(SP, 2026, 7, 31, 21, 30),
    zonedWallTimeToUtc(SP, 2026, 8, 1),
    zonedWallTimeToUtc(SP, 2026, 8, 20, 9),
  ];

  for (const [index, createdAt] of instants.entries()) {
    for (const businessId of index % 2 === 0 ? [CARRIER, OTHER] : [CARRIER]) {
      await prisma.supplier.create({
        data: {
          name: `Fornecedor ${randomUUID().slice(0, 8)}`,
          cnpj: String(31000000000000 + Math.floor(Math.random() * 9_000_000)),
          businessId,
          created_at: createdAt,
        },
      });
    }
  }
}, 90_000);

afterAll(async () => {
  await prisma.supplier.deleteMany({
    where: { businessId: { in: [CARRIER, OTHER] } },
  });
  await prisma.business.deleteMany({ where: { id: { in: [CARRIER, OTHER] } } });
  await prisma.$disconnect();
  await counted.$disconnect();
});

describe("the dashboard's monthly counts", () => {
  it("count index ranges instead of labelling every row", async () => {
    statements.length = 0;

    await repository.countManyByMonth(
      {
        entities: ["supplier"],
        from: businessMonthStart("2026-06", SP),
        to: businessMonthStart("2026-09", SP),
        timeZone: SP,
      },
      CARRIER,
    );

    const counting = statements.filter((statement) =>
      statement.query.includes(`"public"."supplier"`),
    );

    expect(counting).toHaveLength(1);
    expect(counting[0].query).not.toMatch(/date_trunc/i);
    expect(counting[0].query).not.toMatch(/"created_at" AT TIME ZONE/);
    expect(counting[0].query).toMatch(/width_bucket\("created_at"/);
  });

  // The 30-day trends window, by day: the table must be read once whatever
  // the scope. Before, the MASTER plan scanned supplier once per bucket.
  it.each([
    ["the tenant", CARRIER],
    ["a MASTER (every tenant)", undefined],
  ])(
    "read each table once for %s, not once per bucket",
    async (_label, businessId) => {
      statements.length = 0;

      await repository.countManyByPeriod(
        {
          entities: ["supplier", "delivery"],
          from: zonedWallTimeToUtc(SP, 2026, 6, 1),
          to: zonedWallTimeToUtc(SP, 2026, 7, 1),
          granularity: "day",
          timeZone: SP,
        },
        businessId,
      );

      const [statement] = statements.filter((sent) =>
        sent.query.includes(`"public"."supplier"`),
      );
      const rows = await prisma.$queryRawUnsafe<
        Array<{ "QUERY PLAN": unknown }>
      >(
        `EXPLAIN (FORMAT JSON) ${statement.query}`,
        ...(JSON.parse(statement.params) as unknown[]),
      );
      const raw = rows[0]["QUERY PLAN"];
      const plan = (
        (typeof raw === "string" ? JSON.parse(raw) : raw) as Array<{
          Plan: PlanNode;
        }>
      )[0].Plan;

      const scans = (table: string) =>
        flatten(plan).filter((node) => node["Relation Name"] === table);

      expect(scans("supplier"), JSON.stringify(plan)).toHaveLength(1);
      expect(scans("delivery"), JSON.stringify(plan)).toHaveLength(1);
      expect(
        flatten(plan).some(
          (node) =>
            (node["Actual Loops"] ?? 1) > 1 ||
            node["Node Type"] === "Nested Loop",
        ),
      ).toBe(false);
    },
  );

  it("give a MASTER the same days and months as the per-row labels, over every tenant", async () => {
    const from = businessMonthStart("2026-06", SP);
    const to = businessMonthStart("2026-09", SP);

    const months = await repository.countManyByMonth({
      entities: ["supplier"],
      from,
      to,
      timeZone: SP,
    });
    const days = await repository.countManyByPeriod(
      { entities: ["supplier"], from, to, granularity: "day", timeZone: SP },
      undefined,
    );

    const foundMonths = Object.fromEntries(
      months.supplier.map((bucket) => [bucket.month, bucket.count]),
    );
    const foundDays = Object.fromEntries(
      days.supplier.map((bucket) => [bucket.period, bucket.count]),
    );

    expect(foundMonths).toEqual(await perRowLabels(undefined, from, to));
    expect(foundDays).toEqual(await perRowLabels(undefined, from, to, "day"));
    // Both seeded tenants are in it: more than the carrier alone.
    expect(foundMonths["2026-06"]).toBeGreaterThanOrEqual(5);
  });

  it("give the same months as the per-row labels, for the tenant only", async () => {
    const from = businessMonthStart("2026-06", SP);
    const to = businessMonthStart("2026-09", SP);

    const result = await repository.countManyByMonth(
      { entities: ["supplier"], from, to, timeZone: SP },
      CARRIER,
    );
    const found = Object.fromEntries(
      result.supplier.map((bucket) => [bucket.month, bucket.count]),
    );

    expect(found).toEqual(await perRowLabels(CARRIER, from, to));
    expect(found).toEqual({ "2026-06": 3, "2026-07": 2, "2026-08": 2 });
  });

  it("clip a window that ends mid-month, as the month-so-far cards ask", async () => {
    const from = businessMonthStart("2026-07", SP);
    const to = zonedWallTimeToUtc(SP, 2026, 8, 10);

    const result = await repository.countManyByPeriod(
      { entities: ["supplier"], from, to, granularity: "month", timeZone: SP },
      CARRIER,
    );

    expect(
      Object.fromEntries(
        result.supplier.map((bucket) => [bucket.period, bucket.count]),
      ),
    ).toEqual(await perRowLabels(CARRIER, from, to));
  });
});
