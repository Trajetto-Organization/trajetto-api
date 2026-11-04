import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * What Postgres does for one `updated_since` page of /integration/v1/deliveries
 * and /routes (plan of 02/11/2026, L6).
 *
 * An incremental sync asks "what changed since my last poll?" — a handful of
 * rows — but the page is walked in id order, and nothing told the planner
 * where the changed rows were: it walked the primary key across every
 * tenant's history, or read the whole tenant and sorted it, to find them.
 *
 * The fixture is the load seed's size (300 thousand deliveries) over three
 * companies, with uuid v7-shaped ids minted from created_at so the tenants
 * interleave in id order as they do in production; two percent of the
 * history was touched in the last hours, as a day of deliveries being
 * closed. The assertions are on rows read, never on milliseconds.
 */
const prisma = createPrismaClient();

const capture = createPrismaClient({
  log: [{ emit: "event", level: "query" }],
});

const sent: Array<{ query: string; params: string }> = [];

capture.$on("query", (event) => {
  sent.push({ query: event.query, params: event.params });
});

const BIG = "018fdc40-0000-7000-8000-00000000000a";
const MID = "018fdc40-0000-7000-8000-00000000000b";
const SMALL = "018fdc40-0000-7000-8000-00000000000c";

const HOUR_MS = 60 * 60 * 1000;

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

function flatten(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flatten)];
}

/** Every row the scans of `table` produced or threw away, over all loops. */
function rowsTouched(plan: PlanNode, table: string): number {
  return flatten(plan)
    .filter((node) => node["Relation Name"] === table)
    .reduce(
      (sum, node) =>
        sum +
        ((node["Actual Rows"] ?? 0) +
          (node["Rows Removed by Filter"] ?? 0) +
          (node["Rows Removed by Index Recheck"] ?? 0)) *
          (node["Actual Loops"] ?? 1),
      0,
    );
}

/** A uuid v7-shaped id minted from the row's own created_at. */
const V7_FROM = (column: string) => `
  substr(lpad(to_hex((extract(epoch FROM ${column}) * 1000)::bigint), 12, '0'), 1, 8) || '-' ||
  substr(lpad(to_hex((extract(epoch FROM ${column}) * 1000)::bigint), 12, '0'), 9, 4) || '-7' ||
  substr(md5(random()::text), 1, 3) || '-8' || substr(md5(random()::text), 4, 3) || '-' ||
  substr(md5(random()::text), 7, 12)`;

async function seedTenant(
  id: string,
  deliveries: number,
  routes: number,
): Promise<void> {
  const shipperId = randomUUID();
  const driverId = randomUUID();

  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora da Sincronia ${id.slice(-1)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(61000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `sincronia-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.shipper.create({
    data: { id: shipperId, name: "Embarcador", businessId: id },
  });

  await prisma.driver.create({
    data: {
      id: driverId,
      name: "Motorista",
      birth_date: new Date("1990-01-01"),
      cnh: `${driverId}-cnh`,
      cpf: `${driverId}-cpf`,
      rg: `${driverId}-rg`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: id,
    },
  });

  // A year of history; 2% of it touched in the last six hours. The offsets
  // are interval arithmetic, never text: a random() below 1e-4 prints as
  // "7.5e-05", which ::interval refuses — about one seed in five failed.
  await prisma.$executeRawUnsafe(
    `
    INSERT INTO delivery (
      id, recipient_name, city, uf, street, status,
      "businessId", "shipperId", kind, created_at, updated_at
    )
    SELECT ${V7_FROM("t")}, 'Cliente ' || n, 'São Paulo', 'SP', 'Rua ' || n,
           'DELIVERED'::"DeliveryStatus", $1, $2, 'DELIVERY'::"DeliveryKind",
           t,
           CASE WHEN random() < 0.02
                THEN now() - random() * interval '6 hours'
                ELSE t + interval '1 hour' END
    FROM generate_series(1, ${deliveries}) AS n
    CROSS JOIN LATERAL (
      SELECT now() - interval '7 hours' - random() * interval '365 days' AS t
    ) AS stamp
    `,
    id,
    shipperId,
  );

  await prisma.$executeRawUnsafe(
    `
    INSERT INTO route (
      id, code, status, scheduled_date, "businessId", "driverId",
      plan_version, created_at, updated_at
    )
    SELECT ${V7_FROM("t")}, n, 'COMPLETED'::"RouteStatus", t::date, $1, $2, 0,
           t,
           CASE WHEN random() < 0.02
                THEN now() - random() * interval '6 hours'
                ELSE t + interval '1 hour' END
    FROM generate_series(1, ${routes}) AS n
    CROSS JOIN LATERAL (
      SELECT now() - interval '7 hours' - random() * interval '365 days' AS t
    ) AS stamp
    `,
    id,
    driverId,
  );
}

beforeAll(async () => {
  await seedTenant(BIG, 200_000, 20_000);
  await seedTenant(MID, 80_000, 8_000);
  await seedTenant(SMALL, 20_000, 2_000);

  await prisma.$executeRawUnsafe('ANALYZE "delivery"');
  await prisma.$executeRawUnsafe('ANALYZE "route"');
}, 600_000);

afterAll(async () => {
  await capture.$disconnect();
  await prisma.$disconnect();
}, 180_000);

/** EXPLAIN ANALYZE of a captured query, dates re-typed as the ORM sent them. */
async function planOf(query: { query: string; params: string }) {
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
            ? `${part}${placeholder}::timestamp`
            : at < parts.length - 1
              ? `${part}${placeholder}`
              : part,
        )
        .join("");
    }
  });

  const rows = await prisma.$queryRawUnsafe<{ "QUERY PLAN": unknown }[]>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
    ...params,
  );

  const raw = rows[0]["QUERY PLAN"];

  const parsed = (typeof raw === "string" ? JSON.parse(raw) : raw) as Array<{
    Plan: PlanNode;
  }>;

  return parsed[0].Plan;
}

type Resource = "delivery" | "route";

async function pageOf(
  resource: Resource,
  businessId: string,
  updated_since: string,
) {
  const { IntegrationRepository } = await import(
    "@/modules/integration/repositories/integration-repository"
  );

  sent.length = 0;

  const repository = new IntegrationRepository(capture);
  const props = { businessId, limit: 200, updated_since } as never;

  const page =
    resource === "delivery"
      ? await repository.listDeliveries(props)
      : await repository.listRoutes(props);

  const query = sent.find((entry) =>
    new RegExp(`FROM "public"\\."${resource}" WHERE`).test(entry.query),
  );

  expect(query, `nenhuma consulta a ${resource} capturada`).toBeDefined();

  return { page, plan: await planOf(query!) };
}

describe("an updated_since page of the public API", () => {
  it("has a fixture the size of the load seed", async () => {
    expect(await prisma.delivery.count()).toBe(300_000);
  });

  const TENANT_SIZE = {
    delivery: { [BIG]: 200_000, [SMALL]: 20_000 },
    route: { [BIG]: 20_000, [SMALL]: 2_000 },
  } as const;

  for (const resource of ["delivery", "route"] as const) {
    for (const [name, businessId] of [
      ["the big company", BIG],
      ["a small company", SMALL],
    ] as const) {
      for (const [label, windowMs, narrow] of [
        // What an ERP polling on a schedule asks: the last few minutes.
        ["the last half hour", HOUR_MS / 2, true],
        // A sync that fell behind: a wider window, about 2% of the history.
        ["the last six hours", 6 * HOUR_MS + 60_000, false],
      ] as const) {
        it(`reads ${resource} rows by the window, not by the history, for ${name} and ${label}`, async () => {
          const since = new Date(Date.now() - windowMs);

          const { page, plan } = await pageOf(
            resource,
            businessId,
            since.toISOString(),
          );

          // The same answer: what changed in the window, in id order.
          const where = { businessId, updated_at: { gte: since } };
          const changed =
            resource === "delivery"
              ? await prisma.delivery.findMany({
                  where,
                  orderBy: { id: "asc" },
                  take: 200,
                  select: { id: true },
                })
              : await prisma.route.findMany({
                  where,
                  orderBy: { id: "asc" },
                  take: 200,
                  select: { id: true },
                });

          expect(page.data.map((row) => row.id)).toEqual(
            changed.map((row) => row.id),
          );

          const window =
            resource === "delivery"
              ? await prisma.delivery.count({ where })
              : await prisma.route.count({ where });

          const touched = rowsTouched(plan, resource);
          const history = TENANT_SIZE[resource][businessId];

          // Never the company's history: before the index, the half-hour
          // page walked (businessId, id) through all of it, or scanned it.
          expect(
            touched,
            `${label}: a janela de ${window} linhas leu ${touched} de ${history} linhas de ${resource}`,
          ).toBeLessThan(history / 10);

          // An incremental poll reads its window and the page, nothing else.
          // (A wide window may be read in id order instead, which stops at a
          // page: the planner's choice, bounded by the line above.)
          if (narrow) {
            expect(
              touched,
              `${label}: a janela de ${window} linhas leu ${touched} linhas de ${resource}`,
            ).toBeLessThanOrEqual(window * 2 + 200);
          }
        }, 120_000);
      }
    }
  }
});
