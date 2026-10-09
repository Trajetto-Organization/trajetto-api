import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { container } from "tsyringe";

import {
  WebhookDispatchService,
  fanOutWebhookEvent,
} from "@/shared/integration/webhook-dispatch-service";

/**
 * "Postgres is the only queue" rests on one clause: every claim is an UPDATE
 * over a `FOR UPDATE SKIP LOCKED` subselect. Two replicas draining the same
 * table must each take rows the other is not holding — never wait on them,
 * never take them twice.
 *
 * Nothing proved it. Every queue test drives one worker at a time, and the
 * load script that raced two replicas (tests/load/queue-across-replicas.mjs,
 * since removed) could not pass once the SSRF guard started refusing its
 * loopback receiver. Deleting `SKIP LOCKED` from any claim left the whole
 * suite green.
 *
 * Two shapes of proof, per queue:
 *
 *  - a row ANOTHER TRANSACTION HOLDS — what a replica mid-claim looks like —
 *    must be skipped: the claim returns promptly with every other due row,
 *    and the held rows come out untouched. Without SKIP LOCKED the claim
 *    queues behind the lock and the case times out;
 *  - several workers draining one backlog at once must send each row exactly
 *    once, which is the property a customer actually feels.
 *
 * In-process instances stand in for replicas: the only coordination between
 * replicas is the database, and separate instances on the pool race for the
 * same rows exactly the way separate processes do.
 */
const prisma = new PrismaClient();

/** The "other replica": its own connection, holding row locks. */
const holder = new PrismaClient();

const CARRIER = "018fd000-0000-7000-8000-0000000007a1";
const RECIPIENT = "018fd000-0000-7000-8000-0000000007c1";

/** Long enough for a real claim; far shorter than a claim stuck on a lock. */
const CLAIM_BUDGET_MS = 8_000;

type QueueTable =
  | "webhook_delivery"
  | "domain_outbox_event"
  | "notification_delivery"
  | "ai_analysis_request";

/**
 * Locks `ids` in a transaction on the holder connection and keeps them locked
 * until the returned function is called.
 */
async function holdRows(
  table: QueueTable,
  ids: string[],
): Promise<() => Promise<void>> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));

  let markLocked!: () => void;
  const locked = new Promise<void>((resolve) => (markLocked = resolve));

  const transaction = holder.$transaction(
    async (tx) => {
      await tx.$queryRawUnsafe(
        `SELECT "id" FROM "${table}" WHERE "id" = ANY($1::text[]) FOR UPDATE`,
        ids,
      );

      markLocked();
      await released;
    },
    { maxWait: 10_000, timeout: 120_000 },
  );

  await locked;

  return async () => {
    release();
    await transaction;
  };
}

/** The claim either finishes inside the budget, or it waited on a lock. */
async function withinBudget<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `${what} esperou ${CLAIM_BUDGET_MS}ms por linhas travadas por outra transação — o claim perdeu o SKIP LOCKED?`,
          ),
        ),
      CLAIM_BUDGET_MS,
    );
  });

  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let server: Server;
let baseUrl = "";

/** Every webhook POST the receiver saw, by X-Trajetto-Delivery. */
let webhookPosts: string[] = [];

const mail = { sent: [] as string[] };

beforeAll(async () => {
  server = createServer((request, response) => {
    request.resume();

    request.on("end", () => {
      webhookPosts.push(String(request.headers["x-trajetto-delivery"]));
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("ok");
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora das Filas",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "10444888000101",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `filas-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.user.create({
    data: {
      id: RECIPIENT,
      name: "Pessoa Destinatária",
      email: `destinataria-filas-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: CARRIER,
    },
  });

  // The container registrations (repositories, providers) come with the app.
  const { app } = await import("@/http");
  await app.ready();

  container.registerInstance("MailProvider", {
    sendMail: async (message: { referenceId?: string }) => {
      mail.sent.push(String(message.referenceId));
      return { messageId: `<${randomUUID()}@x>` };
    },
  });
}, 120_000);

beforeEach(async () => {
  webhookPosts = [];
  mail.sent = [];

  await prisma.webhookDelivery.deleteMany({});
  await prisma.webhookEndpoint.deleteMany({});
  await prisma.notificationDelivery.deleteMany({});
  await prisma.domainOutboxEvent.deleteMany({});
  await prisma.aIAnalysisRequest.deleteMany({});
});

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await holder.$disconnect();
  await prisma.$disconnect();
}, 60_000);

// ---------------------------------------------------------------------------
// webhook_delivery
// ---------------------------------------------------------------------------

/** Rows spread over several endpoints: the claim caps rows per endpoint. */
async function queueWebhooks(endpoints: number, events: number): Promise<string[]> {
  for (let index = 0; index < endpoints; index += 1) {
    await prisma.webhookEndpoint.create({
      data: {
        name: `Receptor ${index}`,
        url: `${baseUrl}/hook/${index}`,
        secret: "whsec_teste_das_filas",
        topics: ["delivery.delivered"],
        businessId: CARRIER,
      },
    });
  }

  for (let index = 0; index < events; index += 1) {
    await fanOutWebhookEvent({
      topic: "delivery.delivered",
      businessId: CARRIER,
      payload: { delivery_id: randomUUID(), code: `PED-${index}` },
    });
  }

  const rows = await prisma.webhookDelivery.findMany({ select: { id: true } });

  expect(rows).toHaveLength(endpoints * events);

  return rows.map((row) => row.id);
}

/**
 * The receiver runs on 127.0.0.1, which the production destination guard
 * refuses — rightly. These tests measure the claim, not the guard.
 */
const permissiveDispatcher = () =>
  new WebhookDispatchService(async () => ({ allowed: true }));

describe("webhook_delivery", () => {
  it("skips the rows another replica holds and delivers the rest", { timeout: 60_000 }, async () => {
    const ids = await queueWebhooks(4, 3);
    const held = ids.slice(0, 6);

    const release = await holdRows("webhook_delivery", held);

    try {
      await withinBudget(permissiveDispatcher().processBatch(), "o despacho de webhooks");

      const heldRows = await prisma.webhookDelivery.findMany({
        where: { id: { in: held } },
      });

      expect(heldRows.map((row) => `${row.status}:${row.attempts}`)).toEqual(
        held.map(() => "PENDING:0"),
      );

      expect(
        (await prisma.webhookDelivery.findMany({
          where: { id: { notIn: held } },
        })).map((row) => row.status),
      ).toEqual(ids.slice(6).map(() => "DELIVERED"));

      expect(webhookPosts.sort()).toEqual(ids.slice(6).sort());
    } finally {
      await release();
    }
  });

  it("is drained by three replicas at once with every row posted exactly once", { timeout: 90_000 }, async () => {
    // 60 rows: three claims' worth, so the replicas really do overlap.
    const ids = await queueWebhooks(6, 10);

    await Promise.all([
      permissiveDispatcher().processBatch(),
      permissiveDispatcher().processBatch(),
      permissiveDispatcher().processBatch(),
    ]);

    const duplicates = webhookPosts.filter(
      (id, index) => webhookPosts.indexOf(id) !== index,
    );

    expect(duplicates, "o mesmo webhook foi postado mais de uma vez").toEqual([]);
    expect(webhookPosts.sort()).toEqual([...ids].sort());

    const rows = await prisma.webhookDelivery.findMany();

    expect(
      rows.filter((row) => row.status !== "DELIVERED" || row.attempts !== 1),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// domain_outbox_event and notification_delivery
// ---------------------------------------------------------------------------

type Pipeline = import("@/shared/notifications/notification-pipeline-service").NotificationPipelineService;

/**
 * A fresh pipeline per "replica". The constructor is private because
 * production runs one per process; each instance here has its own in-memory
 * reentrancy guards, which is what makes two of them race.
 */
async function newPipeline(): Promise<Pipeline> {
  const { NotificationPipelineService } = await import(
    "@/shared/notifications/notification-pipeline-service"
  );

  return new (NotificationPipelineService as unknown as new () => Pipeline)();
}

async function publishEvents(
  count: number,
  status: "PENDING" | "PUBLISHED" = "PENDING",
): Promise<string[]> {
  const ids: string[] = [];

  for (let index = 0; index < count; index += 1) {
    const event = await prisma.domainOutboxEvent.create({
      data: {
        eventKey: `account-payable.created:${randomUUID()}`,
        topic: "account-payable.created",
        aggregateType: "account-payable",
        aggregateId: randomUUID(),
        businessId: CARRIER,
        actorId: RECIPIENT,
        status,
        payload: {
          accountPayableId: randomUUID(),
          businessId: CARRIER,
          amount: 150,
          serviceOrderId: null,
          registrationUserId: RECIPIENT,
        },
      },
    });

    ids.push(event.id);
  }

  return ids;
}

/** One e-mail row per (already expanded) event: the external lane's work. */
async function queueEmails(count: number): Promise<string[]> {
  const events = await publishEvents(count, "PUBLISHED");

  for (const outboxEventId of events) {
    await prisma.notificationDelivery.create({
      data: { outboxEventId, userId: RECIPIENT, channel: "EMAIL" },
    });
  }

  const rows = await prisma.notificationDelivery.findMany({
    select: { id: true },
  });

  return rows.map((row) => row.id);
}

describe("domain_outbox_event", () => {
  it("skips the events another replica holds and expands the rest", { timeout: 60_000 }, async () => {
    const ids = await publishEvents(12);
    const held = ids.slice(0, 5);

    const release = await holdRows("domain_outbox_event", held);

    try {
      await withinBudget((await newPipeline()).runOutboxCycle(), "a expansão do outbox");

      const events = await prisma.domainOutboxEvent.findMany();

      for (const event of events) {
        expect(`${event.status}:${event.attempts}`, event.id).toBe(
          held.includes(event.id) ? "PENDING:0" : "PUBLISHED:1",
        );
      }
    } finally {
      await release();
    }
  });

  it("is drained by two replicas at once with every event expanded once", { timeout: 90_000 }, async () => {
    await publishEvents(30);

    const [a, b] = [await newPipeline(), await newPipeline()];

    await Promise.all([a.runOutboxCycle(), b.runOutboxCycle()]);

    // The partial unique indexes would hide a double expansion from a row
    // count; the attempt counter is what a second claim moves.
    const events = await prisma.domainOutboxEvent.findMany();

    expect(
      events
        .filter((event) => event.status !== "PUBLISHED" || event.attempts !== 1)
        .map((event) => `${event.id}:${event.status}:${event.attempts}`),
    ).toEqual([]);
  });
});

describe("notification_delivery", () => {
  it("skips the deliveries another replica holds and sends the rest", { timeout: 60_000 }, async () => {
    const ids = await queueEmails(12);
    const held = ids.slice(0, 5);

    const release = await holdRows("notification_delivery", held);

    try {
      await withinBudget(
        (await newPipeline()).runDeliveryCycle("external"),
        "a fila de entregas externas",
      );

      const rows = await prisma.notificationDelivery.findMany();

      for (const row of rows) {
        expect(`${row.status}:${row.attempts}`, row.id).toBe(
          held.includes(row.id) ? "PENDING:0" : "DELIVERED:1",
        );
      }

      expect(mail.sent.sort()).toEqual(ids.slice(5).sort());
    } finally {
      await release();
    }
  });

  it("is drained by two replicas at once with every e-mail sent once", { timeout: 90_000 }, async () => {
    // Sixty: three batches, so both replicas keep claiming while the other
    // is mid-batch.
    const ids = await queueEmails(60);

    const [a, b] = [await newPipeline(), await newPipeline()];

    await Promise.all([
      a.runDeliveryCycle("external"),
      b.runDeliveryCycle("external"),
    ]);

    const duplicates = mail.sent.filter(
      (id, index) => mail.sent.indexOf(id) !== index,
    );

    expect(duplicates, "o mesmo e-mail saiu mais de uma vez").toEqual([]);
    expect(mail.sent.sort()).toEqual([...ids].sort());
  });
});

// ---------------------------------------------------------------------------
// ai_analysis_request
// ---------------------------------------------------------------------------

describe("ai_analysis_request", () => {
  it("skips the requests another replica holds and works through the rest", { timeout: 60_000 }, async () => {
    const period = await prisma.aIUsagePeriod.upsert({
      where: {
        businessId_periodStart: {
          businessId: CARRIER,
          periodStart: new Date("2026-09-01"),
        },
      },
      create: { businessId: CARRIER, periodStart: new Date("2026-09-01") },
      update: {},
    });

    const ids: string[] = [];

    // Requests with no unit: the pipeline closes each one without ever
    // reaching the provider, which is all this case needs — the claim is
    // what is under test, and the attempt counter records it.
    for (let index = 0; index < 8; index += 1) {
      const request = await prisma.aIAnalysisRequest.create({
        data: {
          idempotencyKey: randomUUID(),
          type: "DELIVERY_PROOF",
          recordId: randomUUID(),
          businessId: CARRIER,
          periodId: period.id,
          requestedById: RECIPIENT,
          input: { photoPath: "deliveryProof/x/foto.webp" },
        },
      });

      ids.push(request.id);
    }

    const held = ids.slice(0, 3);
    const release = await holdRows("ai_analysis_request", held);

    try {
      const { AIAnalysisPipelineService } = await import(
        "@/shared/ai/ai-analysis-pipeline-service"
      );

      const pipeline = new (AIAnalysisPipelineService as unknown as new () => {
        runCycle(): Promise<void>;
      })();

      await withinBudget(pipeline.runCycle(), "a fila de análises IA");

      const rows = await prisma.aIAnalysisRequest.findMany();

      for (const row of rows) {
        if (held.includes(row.id)) {
          expect(`${row.status}:${row.attempts}`, row.id).toBe("PENDING:0");
        } else {
          expect(row.attempts, row.id).toBe(1);
        }
      }
    } finally {
      await release();
    }
  });
});
