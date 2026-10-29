import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import { container } from "tsyringe";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The queues claim by due time, and a retry storm is not in the way.
 *
 * The notification claim ordered its lane by `created_at` and asked for
 * `(PENDING AND availableAt <= now()) OR (PROCESSING AND lease expired)`. A
 * row in backoff keeps its original created_at, so during a WhatsApp outage
 * the retrying rows sat at the HEAD of the lane: every claim of the external
 * lane — which also carries every e-mail — read the whole backlog in the heap,
 * one future availableAt after another, before reaching a row that was due.
 *
 * Now the claim writes the lease end into availableAt when it takes a row, so
 * one range on the index key — `availableAt <= now()` — covers both halves:
 * due PENDING rows, and PROCESSING rows whose lease ran out. The scan starts
 * at the oldest due row and stops at now(), whatever is parked in backoff.
 *
 * The SQL measured is captured from what the pipeline really sends.
 */
const sent = vi.hoisted(() => ({
  statements: [] as Array<{ query: string; params: string }>,
}));

vi.mock("@/../infra/database", async () => {
  const { createPrismaClient } = await import(
    "@/shared/database/database-client"
  );

  const client = createPrismaClient({
    log: [{ emit: "event", level: "query" }],
    transactionOptions: { maxWait: 10_000, timeout: 15_000 },
  });

  client.$on("query", (event) => {
    sent.statements.push({ query: event.query, params: event.params });
  });

  return {
    default: client,
    TRANSACTION_OPTIONS: { maxWait: 10_000, timeout: 15_000 },
  };
});

const prisma = createPrismaClient();

let pipeline: import("@/shared/notifications/notification-pipeline-service").NotificationPipelineService;
let webhooks: typeof import("@/shared/integration/webhook-dispatch-service");

const BUSINESS = "018fde00-0000-7000-8000-0000000000b1";
const RECIPIENT = "018fde00-0000-7000-8000-0000000000c1";

/** Rows in backoff during a provider outage, all older than the due one. */
const BACKLOG = 20_000;

const LEASE_SECONDS = 180;

/** Resolves a held e-mail send; null while no send is being held. */
let releaseMail: (() => void) | null = null;
let holdMail = false;

const mail = { sent: [] as Array<{ referenceId?: string }> };

let server: Server;
let baseUrl = "";
let held: Array<{ response: ServerResponse; request: IncomingMessage }> = [];

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  "Rows Removed by Filter"?: number;
  "Shared Hit Blocks"?: number;
  "Shared Read Blocks"?: number;
  Plans?: PlanNode[];
}

/**
 * Pages the whole statement read, index pages included (EXPLAIN BUFFERS; a
 * node's count includes its children's). "Actual Rows" cannot see a bitmap
 * index scan that walks an entire index to find nothing: its node names no
 * relation and returns no rows.
 */
function pagesRead(plan: PlanNode): number {
  return (plan["Shared Hit Blocks"] ?? 0) + (plan["Shared Read Blocks"] ?? 0);
}

function flatten(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flatten)];
}

/** Rows a scan of `table` produced or threw away, over all its loops. */
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
 * EXPLAIN ANALYZE of a captured claim — which is an UPDATE, so it runs in a
 * transaction that is rolled back and claims nothing.
 */
async function planOfClaim(statement: { query: string; params: string }) {
  const params = JSON.parse(statement.params) as unknown[];
  let plan: PlanNode | undefined;

  await prisma
    .$transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<{ "QUERY PLAN": unknown }[]>(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.query}`,
        ...params,
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

async function until(
  condition: () => Promise<boolean> | boolean,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;

  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("condição não atingida a tempo");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** One expanded event whose e-mail row is the only thing left to send. */
async function dueEmail(): Promise<string> {
  const event = await prisma.domainOutboxEvent.create({
    data: {
      eventKey: `account-payable.created:${randomUUID()}`,
      topic: "account-payable.created",
      aggregateType: "account-payable",
      aggregateId: randomUUID(),
      businessId: BUSINESS,
      actorId: RECIPIENT,
      payload: {
        accountPayableId: randomUUID(),
        businessId: BUSINESS,
        amount: 150,
        serviceOrderId: null,
        registrationUserId: RECIPIENT,
      },
    },
  });

  await pipeline.runOutboxCycle();

  await prisma.notificationDelivery.updateMany({
    where: { outboxEventId: event.id, channel: { not: "EMAIL" } },
    data: { status: "DELIVERED", deliveredAt: new Date() },
  });

  const row = await prisma.notificationDelivery.findFirstOrThrow({
    where: { outboxEventId: event.id, channel: "EMAIL" },
  });

  return row.id;
}

beforeAll(async () => {
  server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      held.push({ request, response });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  await prisma.business.create({
    data: {
      id: BUSINESS,
      corporate_reason: "Transportadora da Fila",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "22333444000363",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `fila-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.user.create({
    data: {
      id: RECIPIENT,
      name: "Pessoa Destinatária",
      email: `destinataria-fila-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: BUSINESS,
      whatsapp_phone: "5511999990000",
      whatsapp_notifications_enabled: true,
    },
  });

  const { app } = await import("@/http");
  await app.ready();

  // After the app registered the real providers: the last registration wins.
  container.registerInstance("MailProvider", {
    sendMail: async (message: { referenceId?: string }) => {
      mail.sent.push(message);

      if (holdMail) {
        await new Promise<void>((resolve) => {
          releaseMail = resolve;
        });
      }

      return { messageId: "<m@x>" };
    },
  });

  container.registerInstance("WhatsAppProvider", {
    isConfigured: () => true,
    sendMessage: async () => ({ success: true, messageId: "wamid.1" }),
  });

  pipeline = (
    await import("@/shared/notifications/notification-pipeline-service")
  ).NotificationPipelineService.getInstance();

  webhooks = await import("@/shared/integration/webhook-dispatch-service");
}, 120_000);

beforeEach(async () => {
  mail.sent = [];
  holdMail = false;
  releaseMail = null;
  held = [];

  await prisma.notificationDelivery.deleteMany({});
  await prisma.domainOutboxEvent.deleteMany({});
  await prisma.webhookDelivery.deleteMany({ where: { businessId: BUSINESS } });
  await prisma.webhookEndpoint.deleteMany({ where: { businessId: BUSINESS } });
});

afterAll(async () => {
  for (const entry of held) entry.response.destroy();

  await prisma.notificationDelivery.deleteMany({});
  await prisma.domainOutboxEvent.deleteMany({});
  await prisma.webhookDelivery.deleteMany({ where: { businessId: BUSINESS } });
  await prisma.webhookEndpoint.deleteMany({ where: { businessId: BUSINESS } });
  await prisma.$disconnect();

  await new Promise<void>((resolve) => server.close(() => resolve()));
}, 120_000);

describe("a WhatsApp outage in the external lane", () => {
  beforeEach(async () => {
    // Twenty thousand messages waiting out a backoff, every one of them older
    // than the e-mail that is due now.
    await prisma.$executeRawUnsafe(
      `
      INSERT INTO "domain_outbox_event" (
        "id", "eventKey", "topic", "aggregateType", "aggregateId", "businessId",
        "payload", "status", "availableAt", "created_at", "updated_at"
      )
      SELECT gen_random_uuid()::text, 'backlog:' || n, 'account-payable.created',
             'account-payable', gen_random_uuid()::text, $1, '{}'::jsonb,
             'PUBLISHED', now() - interval '2 hours',
             now() - interval '2 hours', now()
      FROM generate_series(1, ${BACKLOG}) AS n
      `,
      BUSINESS,
    );

    await prisma.$executeRawUnsafe(
      `
      INSERT INTO "notification_delivery" (
        "id", "outboxEventId", "userId", "channel", "status", "attempts",
        "availableAt", "lastError", "created_at", "updated_at"
      )
      SELECT gen_random_uuid()::text, e."id", $1, 'WHATSAPP', 'PENDING', 2,
             now() + interval '1 hour', 'Meta indisponível', e."created_at", now()
      FROM "domain_outbox_event" e
      WHERE e."eventKey" LIKE 'backlog:%'
      `,
      RECIPIENT,
    );

    await prisma.$executeRawUnsafe('ANALYZE "notification_delivery"');
  }, 120_000);

  it("still sends the e-mail that is due, and leaves the backlog waiting", async () => {
    const id = await dueEmail();

    await pipeline.runDeliveryCycle("external");

    expect(mail.sent.map((message) => message.referenceId)).toEqual([id]);

    expect(
      await prisma.notificationDelivery.count({
        where: { channel: "WHATSAPP", status: "PENDING", attempts: 2 },
      }),
    ).toBe(BACKLOG);
  }, 60_000);

  it("finds it without reading the backlog", async () => {
    await dueEmail();

    sent.statements.length = 0;
    await pipeline.runDeliveryCycle("external");

    const claim = sent.statements.find(
      (statement) =>
        /UPDATE "notification_delivery" SET\s+"status" = 'PROCESSING'/.test(
          statement.query,
        ) && statement.query.includes("RETURNING"),
    );

    expect(claim, "o ciclo não enviou o claim").toBeDefined();

    const plan = await planOfClaim(claim!);
    const touched = rowsTouched(plan, "notification_delivery");

    expect(
      touched,
      `o claim leu ${touched} entregas para achar 1 vencida atrás de ${BACKLOG} em espera:\n${claim!.query}`,
    ).toBeLessThan(200);
  }, 60_000);
});

describe("a delivery in flight", () => {
  it("carries its lease end as its due time, so the claim's range skips it", async () => {
    const id = await dueEmail();

    holdMail = true;
    const cycle = pipeline.runDeliveryCycle("external");

    await until(() => releaseMail !== null);

    const row = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { id },
    });

    expect(row.status).toBe("PROCESSING");
    expect(row.leaseExpiresAt).not.toBeNull();

    // Same expression, same statement: equal to the millisecond.
    expect(row.availableAt.getTime()).toBe(row.leaseExpiresAt!.getTime());
    expect(row.availableAt.getTime()).toBeGreaterThan(
      Date.now() + (LEASE_SECONDS - 30) * 1000,
    );

    releaseMail!();
    await cycle;
  }, 30_000);

  it("claimed by an older replica, which did not move availableAt, is still left alone", async () => {
    const id = await dueEmail();

    // What the previous release's claim leaves: a live lease, and the due
    // time it was claimed at — in the past. During a rolling deploy the new
    // claim meets these rows and must not take them.
    await prisma.notificationDelivery.update({
      where: { id },
      data: {
        status: "PROCESSING",
        attempts: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000),
        availableAt: new Date(Date.now() - 60_000),
      },
    });

    await pipeline.runDeliveryCycle("external");

    expect(mail.sent).toHaveLength(0);

    const row = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { id },
    });

    expect(row.status).toBe("PROCESSING");
    expect(row.attempts).toBe(1);
  });
});

describe("a webhook in flight", () => {
  it("carries its lease end as its due time too", async () => {
    await prisma.webhookEndpoint.create({
      data: {
        name: "Receptor",
        url: `${baseUrl}/hold`,
        secret: "whsec_teste_da_fila",
        topics: ["delivery.delivered"],
        businessId: BUSINESS,
      },
    });

    await webhooks.fanOutWebhookEvent({
      topic: "delivery.delivered",
      businessId: BUSINESS,
      payload: {},
    });

    const dispatcher = new webhooks.WebhookDispatchService(async () => ({
      allowed: true,
    }));

    const batch = dispatcher.processBatch();

    await until(() => held.length === 1);

    const row = await prisma.webhookDelivery.findFirstOrThrow({
      where: { businessId: BUSINESS },
    });

    expect(row.status).toBe("PROCESSING");
    expect(row.availableAt.getTime()).toBe(row.leaseExpiresAt!.getTime());

    const [{ response }] = held;
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("ok");

    await batch;
  }, 30_000);
});

describe("a customer's endpoint down, in the webhook queue", () => {
  /**
   * The same storm on the webhook side: a receiver answering 503 for an hour
   * parks its rows in backoff. Its index was already on availableAt, but the
   * claim asked `(PENDING AND due) OR (PROCESSING AND lease over)`, and the
   * PROCESSING arm has no range of its own: the planner either walked the
   * claim index past every parked row, or served that arm by reading all of
   * (businessId, status, created_at) — every tenant's retained month — on
   * every sweep of every replica.
   *
   * Measured in pages read, not rows: a bitmap scan of a whole index that
   * finds nothing returns no rows and names no table.
   */
  const PAGES_BUDGET = 40;

  beforeEach(async () => {
    const endpoint = await prisma.webhookEndpoint.create({
      data: {
        name: "Receptor fora do ar",
        url: `${baseUrl}/down`,
        secret: "whsec_teste_da_fila",
        topics: ["delivery.delivered"],
        businessId: BUSINESS,
      },
    });

    await prisma.$executeRawUnsafe(
      `
      INSERT INTO "webhook_delivery" (
        "id", "endpointId", "businessId", "topic", "payload", "signature",
        "status", "attempts", "availableAt", "lastError", "created_at", "updated_at"
      )
      SELECT gen_random_uuid()::text, $1, $2, 'delivery.delivered', '{}'::jsonb,
             'assinatura', 'PENDING', 2, now() + interval '1 hour', 'HTTP 503',
             now() - interval '2 hours' - n * interval '100 milliseconds', now()
      FROM generate_series(1, ${BACKLOG}) AS n
      `,
      endpoint.id,
      BUSINESS,
    );

    // And the month the ledger keeps for resends, already delivered: what
    // (businessId, status, created_at) mostly holds in production.
    await prisma.$executeRawUnsafe(
      `
      INSERT INTO "webhook_delivery" (
        "id", "endpointId", "businessId", "topic", "payload", "signature",
        "status", "attempts", "availableAt", "deliveredAt", "created_at", "updated_at"
      )
      SELECT gen_random_uuid()::text, $1, $2, 'delivery.delivered', '{}'::jsonb,
             'assinatura', 'DELIVERED', 1, at, at, at, at
      FROM (
        SELECT now() - n * interval '2 minutes' AS at
        FROM generate_series(1, ${BACKLOG}) AS n
      ) AS history
      `,
      endpoint.id,
      BUSINESS,
    );

    await prisma.$executeRawUnsafe('ANALYZE "webhook_delivery"');
  }, 120_000);

  it("claims without reading the rows in backoff", async () => {
    sent.statements.length = 0;

    await new webhooks.WebhookDispatchService(async () => ({
      allowed: true,
    })).processBatch();

    const claim = sent.statements.find(
      (statement) =>
        /UPDATE "webhook_delivery" SET\s+"status" = 'PROCESSING'/.test(
          statement.query,
        ) && statement.query.includes("RETURNING"),
    );

    expect(claim, "o ciclo não enviou o claim").toBeDefined();

    const plan = await planOfClaim(claim!);
    const pages = pagesRead(plan);
    const touched = rowsTouched(plan, "webhook_delivery");

    expect(
      pages,
      `o claim leu ${pages} páginas com ${BACKLOG} webhooks em espera e nenhum vencido:\n${claim!.query}`,
    ).toBeLessThan(PAGES_BUDGET);

    expect(touched).toBeLessThan(200);
  }, 60_000);

  it("which the claim's former shape could not do", async () => {
    // The control: the head of the claim as it was, the OR without the range.
    // If this ever fits the budget, the test above proves nothing.
    const plan = await planOfClaim({
      query: `
        SELECT "id" FROM "webhook_delivery"
        WHERE ("status" = 'PENDING' AND "availableAt" <= now())
           OR ("status" = 'PROCESSING' AND "leaseExpiresAt" < now()
               AND "attempts" < 8)
        ORDER BY "availableAt", "id"
        LIMIT 200
      `,
      params: "[]",
    });

    const pages = pagesRead(plan);

    expect(pages, `a forma antiga leu ${pages} páginas`).toBeGreaterThan(
      PAGES_BUDGET * 2,
    );
  }, 60_000);
});
