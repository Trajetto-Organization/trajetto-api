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

import { container } from "tsyringe";

import {
  failedPurgeBatchSql,
  publishedPurgeBatchSql,
} from "@/jobs/cron/cleanup-notification-pipeline-job";
import { BusinessRepository } from "@/modules/business/repositories/business-repository";
import { WebhookEndpointRepository } from "@/modules/integration/repositories/webhook-endpoint-repository";
import { UserRepository } from "@/modules/user/repositories/user-repository";
import { createPrismaClient } from "@/shared/database/database-client";
import { WebhookDispatchService } from "@/shared/integration/webhook-dispatch-service";

/**
 * The queues without their foreign keys (plano-escala F5-05).
 *
 * notification_delivery, notification_provider_receipt and webhook_delivery
 * hang off user, external_recipient, webhook_endpoint, business and their
 * events through ON DELETE CASCADE. Wave 10 (F5-06) drops every one of
 * those keys. This file drops them from its own database, as that release
 * will, and proves two things:
 *
 *  - each deletion takes its own queue rows (a user, a webhook endpoint, a
 *    company, the nightly purge of PUBLISHED and FAILED events), so nothing
 *    is left behind once no cascade does it;
 *  - a row that escaped a deletion anyway — written while it ran — closes
 *    FAILED as recipient_gone, with no call to any provider (D54).
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];
let pipeline: import("@/shared/notifications/notification-pipeline-service").NotificationPipelineService;

const KEPT = "019a9a60-0000-7000-8000-00000000000a";
const GONE = "019a9a60-0000-7000-8000-00000000000b";

const sendMail = vi.fn(async () => ({ messageId: "<m@example.com>" }));

const DAY_MS = 24 * 60 * 60 * 1000;

function businessData(id: string, cnpj: string) {
  return {
    id,
    corporate_reason: `Transportadora ${cnpj}`,
    cep: "01001000",
    city: "São Paulo",
    uf: "SP",
    street: "Rua",
    address_number: "1",
    cnpj,
    cnae: "4930202",
    responsible_name: "Responsável",
    telephone: "11999999999",
    email: `queue-${randomUUID()}@example.com`,
  };
}

async function newUser(
  businessId: string | null,
  role: "BUSINESS_ADMIN" | "MASTER" = "BUSINESS_ADMIN",
): Promise<string> {
  return (
    await prisma.user.create({
      data: {
        name: "Pessoa da Fila",
        email: `queue-${randomUUID()}@example.com`,
        password: "nao-usado",
        role,
        businessId,
      },
    })
  ).id;
}

async function newEvent(
  businessId: string,
  data: {
    status?: "PUBLISHED" | "FAILED";
    processedAt?: Date;
    updatedAt?: Date;
    actorId?: string;
    registrationUserId?: string;
  } = {},
): Promise<string> {
  const event = await prisma.domainOutboxEvent.create({
    data: {
      eventKey: `queue-no-cascade:${randomUUID()}`,
      topic: "account-payable.created",
      aggregateType: "account-payable",
      aggregateId: randomUUID(),
      businessId,
      actorId: data.actorId ?? null,
      status: data.status ?? "PUBLISHED",
      processedAt: data.processedAt ?? new Date(),
      payload: {
        accountPayableId: randomUUID(),
        businessId,
        amount: 150,
        serviceOrderId: null,
        registrationUserId: data.registrationUserId ?? randomUUID(),
      },
    },
  });

  if (data.updatedAt) {
    await prisma.$executeRaw`
      UPDATE "domain_outbox_event" SET "updated_at" = ${data.updatedAt}
      WHERE "id" = ${event.id}
    `;
  }

  return event.id;
}

/** A delivery and one provider receipt under it. */
async function newDelivery(
  eventId: string,
  to: { userId: string } | { externalRecipientId: string },
  data: {
    channel?: "IN_APP" | "EMAIL" | "ACTIVITY" | "WHATSAPP";
    status?: "PENDING" | "DELIVERED";
  } = {},
): Promise<string> {
  const delivery = await prisma.notificationDelivery.create({
    data: {
      outboxEventId: eventId,
      ...to,
      channel: data.channel ?? "EMAIL",
      status: data.status ?? "DELIVERED",
      // Nothing in this process claims a row before the test says so.
      availableAt: new Date(Date.now() + DAY_MS),
    },
  });

  await prisma.notificationProviderReceipt.create({
    data: {
      deliveryId: delivery.id,
      provider: "resend",
      providerMessageId: randomUUID(),
      status: "delivered",
      occurredAt: new Date(),
    },
  });

  return delivery.id;
}

async function newEndpoint(businessId: string): Promise<string> {
  return (
    await prisma.webhookEndpoint.create({
      data: {
        name: "ERP",
        url: "https://erp.example.com/webhooks",
        secret: "whsec_teste",
        topics: ["delivery.created"],
        businessId,
      },
    })
  ).id;
}

async function newWebhookDelivery(
  businessId: string,
  endpointId: string,
  availableAt = new Date(Date.now() + DAY_MS),
): Promise<string> {
  return (
    await prisma.webhookDelivery.create({
      data: {
        businessId,
        endpointId,
        topic: "delivery.created",
        payload: { id: randomUUID() },
        signature: "v1=teste",
        availableAt,
      },
    })
  ).id;
}

async function deliveriesLeft(ids: string[]) {
  return {
    deliveries: await prisma.notificationDelivery.count({
      where: { id: { in: ids } },
    }),
    receipts: await prisma.notificationProviderReceipt.count({
      where: { deliveryId: { in: ids } },
    }),
  };
}

beforeAll(async () => {
  await prisma.business.createMany({
    data: [
      businessData(KEPT, "66777888000110"),
      businessData(GONE, "66777888000291"),
    ],
  });

  // What wave 10 leaves: no foreign key from or to the four queues.
  await prisma.$executeRawUnsafe(`
    DO $$
    DECLARE fk record;
    BEGIN
      FOR fk IN
        SELECT conrelid::regclass AS tbl, conname
        FROM pg_constraint
        WHERE contype = 'f'
          AND (conrelid::regclass::text IN (
                'notification_delivery', 'notification_provider_receipt',
                'webhook_delivery', 'domain_outbox_event')
            OR confrelid::regclass::text IN (
                'notification_delivery', 'notification_provider_receipt',
                'webhook_delivery', 'domain_outbox_event'))
      LOOP
        EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', fk.tbl, fk.conname);
      END LOOP;
    END $$;
  `);

  ({ app } = await import("@/http"));
  await app.ready();

  container.registerInstance("MailProvider", { sendMail });

  pipeline = (
    await import("@/shared/notifications/notification-pipeline-service")
  ).NotificationPipelineService.getInstance();
}, 120_000);

beforeEach(() => {
  sendMail.mockClear();
});

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
}, 60_000);

describe("without the foreign keys of the queues", () => {
  it("has none left", async () => {
    const [{ n }] = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_constraint
      WHERE contype = 'f'
        AND conrelid::regclass::text IN (
          'notification_delivery', 'notification_provider_receipt',
          'webhook_delivery', 'domain_outbox_event')
    `;

    expect(n).toBe(0);
  });

  it("takes a deleted user's deliveries and receipts, and nobody else's", async () => {
    const user = await newUser(KEPT);
    const other = await newUser(KEPT);
    const event = await newEvent(KEPT);

    const theirs = [
      await newDelivery(event, { userId: user }),
      await newDelivery(event, { userId: user }, { channel: "IN_APP" }),
    ];
    const kept = [await newDelivery(event, { userId: other })];

    await new UserRepository(prisma as never).deleteUser(user);

    expect(await deliveriesLeft(theirs)).toEqual({
      deliveries: 0,
      receipts: 0,
    });
    expect(await deliveriesLeft(kept)).toEqual({ deliveries: 1, receipts: 1 });
  });

  it("takes a deleted MASTER's deliveries and receipts", async () => {
    const master = await newUser(null, "MASTER");
    await newUser(null, "MASTER");
    const event = await newEvent(KEPT);

    const theirs = [await newDelivery(event, { userId: master })];

    expect(
      await new UserRepository(prisma as never).deleteMasterUserKeepingOne(
        master,
      ),
    ).not.toBeNull();
    expect(await deliveriesLeft(theirs)).toEqual({
      deliveries: 0,
      receipts: 0,
    });
  });

  it("drops a user's unsent deliveries with their receipts, and keeps the ledger", async () => {
    const user = await newUser(KEPT);
    const event = await newEvent(KEPT);

    const unsent = [
      await newDelivery(event, { userId: user }, { status: "PENDING" }),
    ];
    const ledger = [
      await newDelivery(event, { userId: user }, { channel: "IN_APP" }),
    ];

    await new UserRepository(prisma as never).endSessionsAndClearInbox(user);

    expect(await deliveriesLeft(unsent)).toEqual({
      deliveries: 0,
      receipts: 0,
    });
    expect(await deliveriesLeft(ledger)).toEqual({
      deliveries: 1,
      receipts: 1,
    });
  });

  it("takes a deleted webhook endpoint's rows, and only through its own company", async () => {
    const endpoint = await newEndpoint(KEPT);
    const other = await newEndpoint(KEPT);
    const rows = [
      await newWebhookDelivery(KEPT, endpoint),
      await newWebhookDelivery(KEPT, endpoint),
    ];
    const kept = await newWebhookDelivery(KEPT, other);

    const endpoints = new WebhookEndpointRepository(prisma as never);

    // Another company's id deletes nothing, the rows included.
    expect(await endpoints.delete(endpoint, GONE)).toBe(false);
    expect(
      await prisma.webhookDelivery.count({ where: { id: { in: rows } } }),
    ).toBe(2);

    expect(await endpoints.delete(endpoint, KEPT)).toBe(true);
    expect(
      await prisma.webhookDelivery.count({ where: { id: { in: rows } } }),
    ).toBe(0);
    expect(await prisma.webhookDelivery.count({ where: { id: kept } })).toBe(1);
  });

  it("takes a deleted company's webhook rows and the deliveries to its people", async () => {
    const user = await newUser(GONE);
    const shipper = await prisma.shipper.create({
      data: { name: "Embarcador", businessId: GONE },
    });
    const order = await prisma.delivery.create({
      data: {
        recipient_name: "Padaria Central",
        code: `PED-${randomUUID().slice(0, 8)}`,
        city: "São Paulo",
        uf: "SP",
        street: "Praça da Sé",
        businessId: GONE,
        shipperId: shipper.id,
      },
    });
    const external = await prisma.externalRecipient.create({
      data: {
        name: "Cliente Final",
        telephone: "5511988887777",
        access_token: randomUUID(),
        deliveryId: order.id,
        businessId: GONE,
      },
    });

    const event = await newEvent(GONE);
    const theirs = [
      await newDelivery(event, { userId: user }),
      await newDelivery(
        event,
        { externalRecipientId: external.id },
        { channel: "WHATSAPP" },
      ),
    ];

    const endpoint = await newEndpoint(GONE);
    await newWebhookDelivery(GONE, endpoint);

    // Another company's rows, untouched.
    const keptEvent = await newEvent(KEPT);
    const kept = [
      await newDelivery(keptEvent, { userId: await newUser(KEPT) }),
    ];
    const keptHook = await newWebhookDelivery(KEPT, await newEndpoint(KEPT));

    await new BusinessRepository(prisma as never).deleteBusiness(GONE);

    expect(await deliveriesLeft(theirs)).toEqual({
      deliveries: 0,
      receipts: 0,
    });
    expect(
      await prisma.webhookDelivery.count({ where: { businessId: GONE } }),
    ).toBe(0);
    expect(await deliveriesLeft(kept)).toEqual({ deliveries: 1, receipts: 1 });
    expect(
      await prisma.webhookDelivery.count({ where: { id: keptHook } }),
    ).toBe(1);
  });

  it("purges an old PUBLISHED event with its deliveries and their receipts", async () => {
    const user = await newUser(KEPT);
    const old = await newEvent(KEPT, {
      processedAt: new Date(Date.now() - 31 * DAY_MS),
    });
    const recent = await newEvent(KEPT);

    const purged = [await newDelivery(old, { userId: user })];
    const kept = [await newDelivery(recent, { userId: user })];

    const [batch] = await prisma.$queryRaw<Array<{ deleted: number }>>(
      publishedPurgeBatchSql(new Date(Date.now() - 30 * DAY_MS), 5_000),
    );

    expect(batch.deleted).toBeGreaterThanOrEqual(1);
    expect(await prisma.domainOutboxEvent.count({ where: { id: old } })).toBe(
      0,
    );
    expect(await deliveriesLeft(purged)).toEqual({
      deliveries: 0,
      receipts: 0,
    });
    expect(await deliveriesLeft(kept)).toEqual({ deliveries: 1, receipts: 1 });
  });

  it("purges an old FAILED event with the deliveries it had and their receipts", async () => {
    const user = await newUser(KEPT);
    const old = await newEvent(KEPT, {
      status: "FAILED",
      updatedAt: new Date(Date.now() - 91 * DAY_MS),
    });

    const purged = [await newDelivery(old, { userId: user })];

    const [batch] = await prisma.$queryRaw<Array<{ deleted: number }>>(
      failedPurgeBatchSql(
        new Date(Date.now() - 90 * DAY_MS),
        new Date(Date.now() - 90 * DAY_MS),
        5_000,
      ),
    );

    expect(batch.deleted).toBe(1);
    expect(await deliveriesLeft(purged)).toEqual({
      deliveries: 0,
      receipts: 0,
    });
  });
});

describe("a queue row whose recipient is gone", () => {
  it("closes FAILED as recipient_gone, at once and without a provider call", async () => {
    const recipient = await newUser(KEPT);
    const actor = await newUser(KEPT);
    const event = await newEvent(KEPT, {
      actorId: actor,
      registrationUserId: recipient,
    });

    const rows = [
      await newDelivery(
        event,
        { userId: recipient },
        { channel: "EMAIL", status: "PENDING" },
      ),
      await newDelivery(
        event,
        { userId: recipient },
        { channel: "IN_APP", status: "PENDING" },
      ),
      await newDelivery(
        event,
        { userId: actor },
        { channel: "ACTIVITY", status: "PENDING" },
      ),
    ];

    // Deleted by a path that did not take their rows: what a transaction
    // committing after the deletion read the queue leaves.
    await prisma.$executeRaw`
      DELETE FROM "user" WHERE "id" IN (${recipient}, ${actor})
    `;
    await prisma.notificationDelivery.updateMany({
      where: { id: { in: rows } },
      data: { availableAt: new Date(Date.now() - 1_000) },
    });

    await pipeline.runDeliveryCycle("internal");
    await pipeline.runDeliveryCycle("external");

    const settled = await prisma.notificationDelivery.findMany({
      where: { id: { in: rows } },
      select: { channel: true, status: true, attempts: true, lastError: true },
    });

    expect(settled).toHaveLength(3);

    for (const row of settled) {
      expect(row.status, row.channel).toBe("FAILED");
      expect(row.attempts, row.channel).toBe(1);
      expect(row.lastError, row.channel).toMatch(/^recipient_gone: /);
    }

    expect(sendMail).not.toHaveBeenCalled();
    expect(
      await prisma.notification.count({ where: { userId: recipient } }),
    ).toBe(0);
  });

  it("closes a webhook row of a deleted endpoint as recipient_gone, with no call", async () => {
    const endpoint = await newEndpoint(KEPT);
    const row = await newWebhookDelivery(
      KEPT,
      endpoint,
      new Date(Date.now() - 1_000),
    );

    await prisma.$executeRaw`
      DELETE FROM "webhook_endpoint" WHERE "id" = ${endpoint}
    `;

    const fetchImpl = vi.fn();
    const dispatcher = new WebhookDispatchService(
      async () => ({ allowed: true }),
      { fetchImpl: fetchImpl as never },
    );

    await dispatcher.processBatch();

    const settled = await prisma.webhookDelivery.findUniqueOrThrow({
      where: { id: row },
    });

    expect(settled.status).toBe("FAILED");
    expect(settled.lastError).toMatch(/^recipient_gone: /);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
