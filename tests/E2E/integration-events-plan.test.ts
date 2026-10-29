import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * What Postgres does for one page of /integration/v1/events.
 *
 * The query used to decide the tenant through the delivery
 * (`delivery: { businessId }`), so every page joined delivery — and with
 * `updated_since` the walk in id order read the tenant's whole history before
 * the window, since the planner cannot know that ids and created_at rise
 * together.
 *
 * Three companies share the table: a big one (forty thousand events over a
 * month), a mid-sized one and a small one. Ids are uuid v7-shaped, minted from
 * each event's created_at, so the tenants interleave in id order exactly as
 * they do in production. The assertions are on rows read, never on
 * milliseconds.
 */
const prisma = createPrismaClient();

const capture = createPrismaClient({
  log: [{ emit: "event", level: "query" }],
});

const sent: Array<{ query: string; params: string }> = [];

capture.$on("query", (event) => {
  sent.push({ query: event.query, params: event.params });
});

const BIG = "018fdc30-0000-7000-8000-00000000000a";
const MID = "018fdc30-0000-7000-8000-00000000000b";
const SMALL = "018fdc30-0000-7000-8000-00000000000c";

const DAY_MS = 24 * 60 * 60 * 1000;

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  "Rows Removed by Filter"?: number;
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
        ((node["Actual Rows"] ?? 0) + (node["Rows Removed by Filter"] ?? 0)) *
          (node["Actual Loops"] ?? 1),
      0,
    );
}

async function seedTenant(
  id: string,
  deliveries: number,
  eventsPerDelivery: number,
): Promise<void> {
  const shipperId = randomUUID();

  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora dos Eventos ${id.slice(-1)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(53000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `eventos-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.shipper.create({
    data: { id: shipperId, name: "Embarcador", businessId: id },
  });

  await prisma.$executeRawUnsafe(
    `
    INSERT INTO delivery (
      id, recipient_name, city, uf, street, status,
      "businessId", "shipperId", kind, created_at, updated_at
    )
    SELECT gen_random_uuid()::text, 'Cliente ' || n, 'São Paulo', 'SP',
           'Rua ' || n, 'DELIVERED'::"DeliveryStatus", $1, $2,
           'DELIVERY'::"DeliveryKind", now() - interval '31 days', now()
    FROM generate_series(1, ${deliveries}) AS n
    `,
    id,
    shipperId,
  );

  // Spread over the last thirty days, with a uuid v7-shaped id minted from
  // the event's own created_at — what Prisma's uuid(7) default produces.
  await prisma.$executeRawUnsafe(
    `
    INSERT INTO delivery_event (id, type, "deliveryId", "businessId", created_at)
    SELECT substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-7' ||
             substr(r, 1, 3) || '-8' || substr(r, 4, 3) || '-' || substr(r, 7, 12),
           'ARRIVAL'::"DeliveryEventType", x.id, x."businessId", x.t
    FROM (
      SELECT d.id, d."businessId", t,
             lpad(to_hex((extract(epoch FROM t) * 1000)::bigint), 12, '0') AS h,
             md5(random()::text) AS r
      FROM delivery d
      CROSS JOIN generate_series(1, ${eventsPerDelivery})
      CROSS JOIN LATERAL (
        SELECT now() - (random() * 30 || ' days')::interval AS t
      ) AS stamp
      WHERE d."businessId" = $1
    ) AS x
    `,
    id,
  );
}

beforeAll(async () => {
  await seedTenant(BIG, 400, 100);
  await seedTenant(MID, 40, 100);
  await seedTenant(SMALL, 3, 100);

  await prisma.$executeRawUnsafe('ANALYZE "delivery"');
  await prisma.$executeRawUnsafe('ANALYZE "delivery_event"');
}, 300_000);

afterAll(async () => {
  await prisma.delivery.deleteMany({
    where: { businessId: { in: [BIG, MID, SMALL] } },
  });
  await prisma.shipper.deleteMany({
    where: { businessId: { in: [BIG, MID, SMALL] } },
  });
  await prisma.business.deleteMany({
    where: { id: { in: [BIG, MID, SMALL] } },
  });

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
          // `$1` must not also match the start of `$10`.
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

async function pageOf(businessId: string, updated_since?: string) {
  const { IntegrationRepository } = await import(
    "@/modules/integration/repositories/integration-repository"
  );

  sent.length = 0;

  const page = await new IntegrationRepository(capture).listEvents({
    businessId,
    limit: 200,
    updated_since,
  } as never);

  const events = sent.find((entry) =>
    /FROM "public"\."delivery_event"/.test(entry.query),
  );

  expect(events).toBeDefined();

  return { page, plan: await planOf(events!) };
}

describe("a page of the public events feed", () => {
  it("has a fixture big enough to mean anything", async () => {
    expect(
      await prisma.deliveryEvent.count({ where: { businessId: BIG } }),
    ).toBe(40_000);
  });

  for (const [name, businessId] of [
    ["the big company", BIG],
    ["a mid-sized company", MID],
    ["a small company", SMALL],
  ] as const) {
    it(`decides the tenant on the event row, for ${name}`, async () => {
      const { plan } = await pageOf(businessId);

      // The delivery is read by primary key, in a separate query, for the
      // rows kept — never to decide which events belong to the tenant.
      expect(rowsTouched(plan, "delivery")).toBe(0);

      const touched = rowsTouched(plan, "delivery_event");

      expect(
        touched,
        `uma página de eventos leu ${touched} linhas de delivery_event`,
      ).toBeLessThan(1_000);
    });
  }

  it("starts an updated_since walk at the window, not at the oldest event", async () => {
    const since = new Date(Date.now() - 2 * DAY_MS);

    const { page, plan } = await pageOf(BIG, since.toISOString());

    // The same answer: every row in the window, in id order.
    expect(page.data).toHaveLength(200);
    expect(
      page.data.every((event) => new Date(event.occurred_at) >= since),
    ).toBe(true);

    const expected = await prisma.deliveryEvent.findMany({
      where: { businessId: BIG, created_at: { gte: since } },
      orderBy: { id: "asc" },
      take: 200,
      select: { id: true },
    });

    expect(page.data.map((event) => event.id)).toEqual(
      expected.map((event) => event.id),
    );

    expect(rowsTouched(plan, "delivery")).toBe(0);

    // Bounded by the window (plus the id floor's ten-minute margin), whichever
    // of the two indexes the planner picks — never by the history before it.
    // Walking (businessId, id) from the tenant's oldest event read ~37k here;
    // joining through delivery, ~41k.
    const window = await prisma.deliveryEvent.count({
      where: {
        businessId: BIG,
        created_at: { gte: new Date(since.getTime() - 10 * 60 * 1000) },
      },
    });

    const touched = rowsTouched(plan, "delivery_event");

    expect(
      touched,
      `a janela de 2 dias (${window} eventos) leu ${touched} linhas de delivery_event`,
    ).toBeLessThanOrEqual(window);

    expect(window).toBeLessThan(40_000 / 5);
  });
});
