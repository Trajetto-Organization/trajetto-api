import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { DeliveryRepository } from "@/modules/delivery/repositories/delivery-repository";
import { RouteRepository } from "@/modules/route/repositories/route-repository";
import { NotificationRepository } from "@/modules/notification/repositories/notification-repository";
import { ActivityRepository } from "@/modules/activity/repositories/activity-repository";
import { ProofAuditRepository } from "@/modules/delivery/repositories/proof-audit-repository";
import { WebhookDeliveryRepository } from "@/modules/integration/repositories/webhook-delivery-repository";
import { IntegrationRepository } from "@/modules/integration/repositories/integration-repository";
import { SupportTicketRepository } from "@/modules/chat/repositories/support-ticket-repository";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The plans the db-perf pass of 07/10/2026 fixed (docs/desempenho/banco-2026-10.md).
 *
 * Each case runs the REAL repository method on a logging client, takes the
 * statement Prisma actually sent and asks Postgres what it does with it —
 * EXPLAIN ANALYZE with the same values. Each one was measured on a scratch
 * database with 50 companies and 1M deliveries; here the volume is just
 * enough for the planner to prefer the bad path when the right index is
 * missing, so every assertion failed before the migration
 * 20261007120000_db_perf_indexes (or the code change named in the case).
 *
 * Access paths only, never milliseconds: a busy machine must not turn this red.
 */
const prisma = createPrismaClient();

const capture = createPrismaClient({
  log: [{ emit: "event", level: "query" }],
});

const sent: Array<{ query: string; params: string }> = [];

capture.$on("query", (event) => {
  sent.push({ query: event.query, params: event.params });
});

async function statementsOf(run: () => Promise<unknown>) {
  sent.length = 0;
  await run();
  return [...sent];
}

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  "Rows Removed by Filter"?: number;
  "Heap Fetches"?: number;
  "Shared Hit Blocks"?: number;
  "Shared Read Blocks"?: number;
  Plans?: PlanNode[];
}

function flatten(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flatten)];
}

function describePlan(plan: PlanNode): string {
  return flatten(plan)
    .map(
      (node) =>
        `${node["Node Type"]}${node["Relation Name"] ? ` ${node["Relation Name"]}` : ""}${node["Index Name"] ? ` [${node["Index Name"]}]` : ""}`,
    )
    .join(" → ");
}

/** Rows a table's scans produced plus the ones they threw away, over all loops. */
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

/**
 * Pages a table's scans visited. An index scan whose condition is not on the
 * index's leading column walks the whole index and reports only what it
 * kept, so rows alone would not show it; the pages it read do.
 */
function pagesRead(plan: PlanNode, table: string): number {
  return flatten(plan)
    .filter((node) => node["Relation Name"] === table)
    .reduce(
      (sum, node) =>
        sum +
        (node["Shared Hit Blocks"] ?? 0) +
        (node["Shared Read Blocks"] ?? 0),
      0,
    );
}

function scanNodes(plan: PlanNode, table: string): PlanNode[] {
  return flatten(plan).filter((node) => node["Relation Name"] === table);
}

/**
 * EXPLAIN ANALYZE of a captured statement with its own values. Prisma logs a
 * date as "2026-10-07 12:00:00.000 UTC"; re-sent as text it would not compare
 * with a timestamp column, so its placeholder gets the type back.
 */
async function planOf(statement: {
  query: string;
  params: string;
}): Promise<PlanNode> {
  const params = JSON.parse(statement.params) as unknown[];
  let sql = statement.query;

  params.forEach((value, index) => {
    if (
      typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(value)
    )
      return;

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
  });

  const rows = await prisma.$queryRawUnsafe<{ "QUERY PLAN": unknown }[]>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
    ...params,
  );

  const raw = rows[0]["QUERY PLAN"];

  return (
    (typeof raw === "string" ? JSON.parse(raw) : raw) as Array<{
      Plan: PlanNode;
    }>
  )[0].Plan;
}

function only(
  statements: Array<{ query: string; params: string }>,
  pattern: RegExp,
) {
  const matching = statements.filter((statement) =>
    pattern.test(statement.query),
  );

  expect(
    matching.length,
    `nenhuma consulta casou com ${pattern}`,
  ).toBeGreaterThan(0);

  return matching;
}

const CARRIER = randomUUID();
const OTHER = randomUUID();
const SMALL = randomUUID();

const ADMIN = randomUUID();
const OTHER_ADMIN = randomUUID();
const DRIVER = randomUUID();

/** Big enough that the wrong path is the planner's choice when the index is missing. */
const CARRIER_DELIVERIES = 20_000;
const OTHER_DELIVERIES = 40_000;
const SMALL_DELIVERIES = 300;

async function createBusiness(id: string, name: string) {
  await prisma.business.create({
    data: {
      id,
      corporate_reason: `${name} ${id.slice(0, 8)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(53000000000000 + Math.floor(Math.random() * 9_000_000_000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `scale-${randomUUID()}@exemplo.com.br`,
    },
  });
}

async function sql(text: string, ...params: unknown[]) {
  await prisma.$executeRawUnsafe(text, ...params);
}

beforeAll(async () => {
  await createBusiness(CARRIER, "Transportadora");
  await createBusiness(OTHER, "Vizinha");
  await createBusiness(SMALL, "Pequena");

  for (const [id, businessId] of [
    [ADMIN, CARRIER],
    [OTHER_ADMIN, OTHER],
  ]) {
    await prisma.user.create({
      data: {
        id,
        name: `Administrador ${id.slice(0, 4)}`,
        email: `scale-${id}@exemplo.com.br`,
        password: "nao-usado",
        role: "BUSINESS_ADMIN",
        businessId,
      },
    });
  }

  // One shipper and twenty drivers per company (one driver for the small one).
  await sql(
    `INSERT INTO shipper (id, name, "businessId", updated_at)
     SELECT gen_random_uuid()::text, 'Embarcador', b, now() FROM unnest($1::text[]) b`,
    [CARRIER, OTHER, SMALL],
  );

  await sql(
    `INSERT INTO driver (id, name, birth_date, cnh, cpf, rg, cep, city, uf, street, address_number,
                         status, contract_type, "businessId", updated_at)
     SELECT CASE WHEN b = $1 AND k = 1 THEN $3 ELSE gen_random_uuid()::text END,
            'Motorista ' || k, '1985-01-01', lpad((k + i * 100)::text, 11, '0'), lpad((k + i * 100)::text, 11, '1'),
            'RG', '01001000', 'São Paulo', 'SP', 'Rua', '1', 'ACTIVE', 'OWNED', b, now()
     FROM unnest($2::text[]) WITH ORDINALITY AS t(b, i), generate_series(1, 20) k`,
    CARRIER,
    [CARRIER, OTHER, SMALL],
    DRIVER,
  );

  // Deliveries: the carrier's, a bigger neighbour's and a small company's,
  // interleaved in id order (random UUIDs) as real tenants are.
  await sql(
    `INSERT INTO delivery (id, recipient_name, city, uf, street, status, "businessId", "shipperId", "driverId",
                           kind, created_at, updated_at)
     SELECT gen_random_uuid()::text, 'Cliente ' || n, 'São Paulo', 'SP', 'Rua ' || n,
            (ARRAY['PENDING','IN_TRANSIT','DELIVERED','FAILED','CANCELLED'])[1 + n % 5]::"DeliveryStatus",
            c.b, s.id, d.id, 'DELIVERY', now() - (n || ' minutes')::interval, now() - (n || ' minutes')::interval
     FROM (VALUES ($1, $4::int), ($2, $5::int), ($3, $6::int)) AS c(b, total)
     CROSS JOIN LATERAL generate_series(1, c.total) n
     JOIN shipper s ON s."businessId" = c.b
     JOIN LATERAL (SELECT id FROM driver WHERE "businessId" = c.b ORDER BY cnh OFFSET (n % 20) LIMIT 1) d ON true`,
    CARRIER,
    OTHER,
    SMALL,
    CARRIER_DELIVERIES,
    OTHER_DELIVERIES,
    SMALL_DELIVERIES,
  );

  // The neighbour's history of finished stops, and three open stops of the carrier.
  await sql(
    `INSERT INTO route (id, code, scheduled_date, status, "businessId", "driverId", updated_at)
     SELECT 'scale-route-' || g || '-' || $1, g, current_date - g, 'COMPLETED', $1,
            (SELECT id FROM driver WHERE "businessId" = $1 LIMIT 1), now()
     FROM generate_series(1, 2000) g`,
    OTHER,
  );

  await sql(
    `INSERT INTO route_stop (id, sequence, status, "routeId", "deliveryId", updated_at)
     SELECT gen_random_uuid()::text, row_number() OVER (PARTITION BY r ORDER BY d.id)::int, 'COMPLETED',
            'scale-route-' || r || '-' || $1, d.id, now()
     FROM (SELECT id, 1 + (row_number() OVER (ORDER BY id) % 2000) AS r FROM delivery WHERE "businessId" = $1) d`,
    OTHER,
  );

  await sql(
    `INSERT INTO route (id, code, scheduled_date, status, "businessId", "driverId", updated_at)
     VALUES ('scale-open-route-' || $1, 1, current_date, 'PLANNED', $1, $2, now())`,
    CARRIER,
    DRIVER,
  );

  await sql(
    `INSERT INTO route_stop (id, sequence, status, "routeId", "deliveryId", updated_at)
     SELECT gen_random_uuid()::text, row_number() OVER (ORDER BY id)::int, 'PENDING', 'scale-open-route-' || $1, id, now()
     FROM (SELECT id FROM delivery WHERE "businessId" = $1 AND status = 'PENDING' ORDER BY id LIMIT 3) d`,
    CARRIER,
  );

  // Occurrences: four types per company, one occurrence per delivery.
  await sql(
    `INSERT INTO occurrence_type (id, name, "businessId", updated_at, category, blocks_delivery)
     SELECT gen_random_uuid()::text, 'Tipo ' || k, b, now(), 'NOT_DELIVERED', false
     FROM unnest($1::text[]) b, generate_series(1, 4) k`,
    [CARRIER, OTHER],
  );

  await sql(
    `INSERT INTO delivery_occurrence (id, "deliveryId", "businessId", "occurrenceTypeId", "reportedById",
                                     created_at, updated_at, category)
     SELECT gen_random_uuid()::text, d.id, d."businessId", t.id,
            CASE WHEN d."businessId" = $1 THEN $2 ELSE $3 END, d.created_at, now(), 'NOT_DELIVERED'
     FROM delivery d
     JOIN LATERAL (SELECT id FROM occurrence_type WHERE "businessId" = d."businessId" ORDER BY name
                   OFFSET (abs(hashtext(d.id)) % 4) LIMIT 1) t ON true
     WHERE d."businessId" IN ($1, $4)`,
    CARRIER,
    ADMIN,
    OTHER_ADMIN,
    OTHER,
  );

  // The bell: thirty thousand read notifications and fifty unread ones.
  await sql(
    `INSERT INTO notification (id, type, title, message, read, "businessId", "userId", created_at, updated_at)
     SELECT gen_random_uuid()::text, 'delivery', 'Entrega', 'Mudou', n > 50, $1, $2,
            now() - (n || ' minutes')::interval, now()
     FROM generate_series(1, 30050) n`,
    CARRIER,
    ADMIN,
  );

  // The audit trail of both companies.
  await sql(
    `INSERT INTO activity (id, type, action, "entityId", description, status, "businessId", "performedBy",
                           created_at, updated_at, "visibilityLevel")
     SELECT gen_random_uuid()::text, 'DELIVERY', 'UPDATE', 'x', 'Entrega atualizada', 'SUCCESS', b, u,
            now() - (n || ' minutes')::interval, now(), 'COMPANY'
     FROM (VALUES ($1, $2), ($3, $4)) AS c(b, u), generate_series(1, 30000) n`,
    CARRIER,
    ADMIN,
    OTHER,
    OTHER_ADMIN,
  );

  // Proof audits: the carrier's decided history.
  await sql(
    `INSERT INTO delivery_proof_audit (id, "deliveryId", "businessId", status, created_at, updated_at,
                                       reviewed_at, "reviewedById")
     SELECT gen_random_uuid()::text, id, "businessId", 'APPROVED', created_at, now(),
            created_at + interval '1 hour', $2
     FROM delivery WHERE "businessId" = $1`,
    CARRIER,
    ADMIN,
  );

  // Webhooks: a small carrier stream next to a big neighbour's.
  await sql(
    `INSERT INTO webhook_endpoint (id, name, url, secret, "businessId", updated_at)
     SELECT 'scale-endpoint-' || b, 'ERP', 'https://erp.example.com/hook', 'sealed', b, now()
     FROM unnest($1::text[]) b`,
    [CARRIER, OTHER],
  );

  await sql(
    `INSERT INTO webhook_delivery (id, "endpointId", topic, payload, signature, status, "businessId",
                                   created_at, updated_at, latency_ms)
     SELECT gen_random_uuid()::text, 'scale-endpoint-' || c.b, 'delivery.status_changed', '{}'::jsonb, 'sig',
            'DELIVERED', c.b, now() - (n || ' seconds')::interval, now(), 100 + n % 50
     FROM (VALUES ($1, 3000), ($2, 60000)) AS c(b, total), generate_series(1, c.total) n`,
    CARRIER,
    OTHER,
  );

  // Tickets: one thread per carrier driver, twenty thousand tickets, mostly closed.
  await sql(
    `INSERT INTO chat_thread (id, "businessId", "driverId", updated_at)
     SELECT gen_random_uuid()::text, "businessId", id, now() FROM driver WHERE "businessId" = $1`,
    CARRIER,
  );

  await sql(
    `INSERT INTO support_ticket (id, number, kind, status, subject, "businessId", "threadId", "driverId",
                                 opened_via, closed_at, last_message_at, created_at, updated_at)
     SELECT gen_random_uuid()::text, n, 'DRIVER', (CASE WHEN n % 50 = 0 THEN 'OPEN' ELSE 'CLOSED' END)::"SupportTicketStatus",
            'Atendimento ' || n, $1, t.id, t."driverId", 'DRIVER_APP',
            CASE WHEN n % 50 = 0 THEN NULL ELSE now() - (n || ' minutes')::interval END,
            now() - (n || ' minutes')::interval, now() - (n || ' minutes')::interval, now()
     FROM generate_series(1, 20000) n
     JOIN LATERAL (SELECT id, "driverId" FROM chat_thread WHERE "businessId" = $1 ORDER BY id OFFSET (n % 20) LIMIT 1) t ON true`,
    CARRIER,
  );

  // Statistics and the visibility map: without them the planner works from an
  // empty table and no index-only scan is possible.
  for (const table of [
    "delivery",
    "route",
    "route_stop",
    "delivery_occurrence",
    "notification",
    "activity",
    "delivery_proof_audit",
    "webhook_delivery",
    "support_ticket",
    "driver",
  ]) {
    await sql(`VACUUM (ANALYZE) "${table}"`);
  }
}, 600_000);

afterAll(async () => {
  await capture.$disconnect();
  await prisma.$disconnect();
});

describe("the fixture is big enough to mean anything", () => {
  it("has the volume the plans below depend on", async () => {
    expect(
      await prisma.delivery.count({ where: { businessId: CARRIER } }),
    ).toBe(CARRIER_DELIVERIES);
    expect(
      await prisma.routeStop.count({ where: { status: "COMPLETED" } }),
    ).toBe(OTHER_DELIVERIES);
    expect(
      await prisma.notification.count({
        where: { userId: ADMIN, read: false },
      }),
    ).toBe(50);
  });
});

describe("a delivery with no open stop (the route anti-join)", () => {
  it("is found without reading every company's finished stops — the app's count", async () => {
    const repository = new DeliveryRepository(capture);

    const [statement] = await statementsOf(() =>
      repository.countPendingForDriver(CARRIER, DRIVER),
    );
    const plan = await planOf(statement);

    // The open stops are a handful; the finished ones are the platform's
    // history (40,000 here, about 200 pages of any index over them).
    expect(rowsTouched(plan, "route_stop"), describePlan(plan)).toBeLessThan(
      1_000,
    );
    expect(pagesRead(plan, "route_stop"), describePlan(plan)).toBeLessThan(30);
  });

  it("and the route builder's picker, every query of it", async () => {
    const repository = new RouteRepository(capture);

    const statements = await statementsOf(() =>
      repository.listUnroutedDeliveries({
        businessId: CARRIER,
        page: 1,
        pageSize: 20,
        includeUnscheduled: true,
      }),
    );

    for (const statement of only(statements, /"route_stop"/)) {
      const plan = await planOf(statement);

      expect(rowsTouched(plan, "route_stop"), describePlan(plan)).toBeLessThan(
        1_000,
      );
      expect(pagesRead(plan, "route_stop"), describePlan(plan)).toBeLessThan(
        30,
      );
    }
  });
});

describe("the deliveries listing's filter counts", () => {
  async function expectIndexOnly(
    statements: Array<{ query: string; params: string }>,
  ) {
    for (const statement of statements) {
      const plan = await planOf(statement);
      const scans = scanNodes(plan, "delivery");

      expect(scans.length, describePlan(plan)).toBe(1);
      expect(
        scans.every((node) => node["Node Type"] === "Index Only Scan"),
        `${statement.query.slice(0, 120)}: ${describePlan(plan)}`,
      ).toBe(true);
    }
  }

  // The board's default view: the three facets share one `where`, so one
  // GROUPING SETS read answers them (docs/desempenho/carga-2026-10.md), and it
  // must still come from the covering index alone.
  it("in the default view are one GROUPING SETS read, from an index alone", async () => {
    const repository = new DeliveryRepository(capture);

    const statements = await statementsOf(() =>
      repository.listDeliveries({
        businessId: CARRIER,
        page: 1,
        pageSize: 10,
      } as never),
    );

    const facets = only(statements, /GROUP BY/);

    expect(facets).toHaveLength(1);
    expect(facets[0].query).toMatch(/GROUPING SETS/);

    await expectIndexOnly(facets);
  });

  it("and for a driver's token (scopeDriverId) too", async () => {
    const repository = new DeliveryRepository(capture);

    const statements = await statementsOf(() =>
      repository.listDeliveries({
        businessId: CARRIER,
        scopeDriverId: DRIVER,
        page: 1,
        pageSize: 10,
      } as never),
    );

    const facets = only(statements, /GROUP BY/);

    expect(facets).toHaveLength(1);
    expect(facets[0].query).toMatch(/GROUPING SETS/);
    expect(facets[0].query).toMatch(/"driverId" = \$2/);

    await expectIndexOnly(facets);
  });

  // With a facet chosen each count drops its own filter, so the three
  // `where`s differ and stay three grouped reads, each index-only.
  it("with a facet chosen are three grouped reads, each from an index alone", async () => {
    const repository = new DeliveryRepository(capture);

    const statements = await statementsOf(() =>
      repository.listDeliveries({
        businessId: CARRIER,
        statuses: ["DELIVERED"],
        page: 1,
        pageSize: 10,
      } as never),
    );

    const facets = only(statements, /GROUP BY/);

    expect(facets).toHaveLength(3);
    expect(
      facets.some((statement) => /GROUPING SETS/.test(statement.query)),
    ).toBe(false);

    await expectIndexOnly(facets);
  });
});

describe("the occurrences listing's type counts", () => {
  it("come from an index of the company, not a scan of every company's occurrences", async () => {
    const repository = new DeliveryRepository(capture);

    const statements = await statementsOf(() =>
      repository.listOccurrences({
        businessId: CARRIER,
        page: 1,
        pageSize: 10,
      } as never),
    );

    const [facet] = only(
      statements,
      /GROUP BY "public"\."delivery_occurrence"\."occurrenceTypeId"/,
    );
    const plan = await planOf(facet);

    expect(
      scanNodes(plan, "delivery_occurrence").every(
        (node) => node["Node Type"] === "Index Only Scan",
      ),
      describePlan(plan),
    ).toBe(true);
  });
});

describe("the bell's unread count", () => {
  it("reads the unread rows, not the user's whole history", async () => {
    const repository = new NotificationRepository(capture);

    const [statement] = await statementsOf(() =>
      repository.countUnreadNotifications(ADMIN),
    );
    const plan = await planOf(statement);

    expect(
      rowsTouched(plan, "notification"),
      describePlan(plan),
    ).toBeLessThanOrEqual(100);
  });
});

describe("the activity trail's total", () => {
  it("is counted from an index, without visiting each row of the trail", async () => {
    const repository = new ActivityRepository(capture);

    const statements = await statementsOf(() =>
      repository.listAllActivities({
        businessId: CARRIER,
        page: 1,
        pageSize: 20,
        currentUserRole: "BUSINESS_ADMIN",
        userId: ADMIN,
      } as never),
    );

    const [count] = only(statements, /SELECT COUNT\(\*\)/);
    const plan = await planOf(count);

    expect(
      scanNodes(plan, "activity").every(
        (node) => node["Node Type"] === "Index Only Scan",
      ),
      describePlan(plan),
    ).toBe(true);
  });
});

describe("the proof audit history tab", () => {
  it("pages the decisions in order without sorting the company's history", async () => {
    const repository = new ProofAuditRepository(capture);

    const statements = await statementsOf(() =>
      repository.listQueue({
        businessId: CARRIER,
        status: "APPROVED",
        page: 1,
        pageSize: 20,
        agreementSince: new Date(Date.now() - 90 * 86_400_000),
      } as never),
    );

    const [page] = only(
      statements,
      /ORDER BY "public"\."delivery_proof_audit"\."reviewed_at" DESC/,
    );
    const plan = await planOf(page);

    expect(
      rowsTouched(plan, "delivery_proof_audit"),
      describePlan(plan),
    ).toBeLessThan(200);
  });
});

describe("the webhook monitor", () => {
  const since = () => new Date(Date.now() - 7 * 86_400_000);

  it("counts up to its cap inside the company, never walking the neighbour's rows", async () => {
    const repository = new WebhookDeliveryRepository(capture);

    const statements = await statementsOf(() =>
      repository.monitor({
        businessId: CARRIER,
        since: since(),
        page: 1,
        pageSize: 20,
        cap: 1_000,
      }),
    );

    // Prisma 7 aliases the count (`COUNT(*) AS "_count$_all"`); the capped
    // sub-select it wraps is the same.
    const [count] = only(
      statements,
      /SELECT COUNT\(\*\)(?: AS "[^"]+")? FROM \(SELECT .* LIMIT/,
    );
    const plan = await planOf(count);

    // The carrier has 3,000 rows; the neighbour 60,000 interleaved by id.
    expect(
      rowsTouched(plan, "webhook_delivery"),
      describePlan(plan),
    ).toBeLessThan(1_500);
  });

  it("and reads the p95 from an index, not from each delivered row", async () => {
    const repository = new WebhookDeliveryRepository(capture);

    const statements = await statementsOf(() =>
      repository.monitor({
        businessId: CARRIER,
        since: since(),
        page: 1,
        pageSize: 20,
        cap: 1_000,
      }),
    );

    const [p95] = only(statements, /percentile_disc/);
    const plan = await planOf(p95);

    expect(
      scanNodes(plan, "webhook_delivery").every(
        (node) => node["Node Type"] === "Index Only Scan",
      ),
      describePlan(plan),
    ).toBe(true);
  });
});

describe("the public API's listing of a small company", () => {
  it("walks that company's ids, not the platform's", async () => {
    const repository = new IntegrationRepository(capture);

    const [page] = await statementsOf(() =>
      repository.listDeliveries({ businessId: SMALL, limit: 100 }),
    );
    const plan = await planOf(page);

    expect(rowsTouched(plan, "delivery"), describePlan(plan)).toBeLessThan(
      SMALL_DELIVERIES,
    );
  });
});

describe("the ticket inbox", () => {
  for (const status of ["CLOSED", "ALL"] as const) {
    it(`pages the ${status} tab in order without sorting the company's tickets`, async () => {
      const repository = new SupportTicketRepository(capture);

      const statements = await statementsOf(() =>
        repository.list({
          businessId: CARRIER,
          requesterUserId: ADMIN,
          status,
          scope: "ALL",
          page: 1,
          pageSize: 20,
        }),
      );

      const [page] = only(
        statements,
        /FROM "public"\."support_ticket" WHERE .* ORDER BY .* LIMIT/,
      );
      const plan = await planOf(page);

      expect(
        rowsTouched(plan, "support_ticket"),
        describePlan(plan),
      ).toBeLessThan(200);
    });
  }
});
