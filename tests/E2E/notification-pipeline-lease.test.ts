import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { container } from "tsyringe";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The lease, from both sides, on both queues of the notification pipeline.
 *
 * A row in PROCESSING belongs to whichever replica claimed it until its lease
 * runs out. Claiming it earlier is the duplicate WhatsApp this whole design
 * exists to prevent; never claiming it after is a message lost with the
 * replica that died holding it. The pipeline's other tests only ever put
 * PENDING rows (or a row past its last attempt) in front of the claim, so the
 * `"leaseExpiresAt" < now()` comparison could be flipped either way and every
 * one of them stayed green. These pin it, each case with its mirror.
 *
 * Rows are seeded the way a claim leaves them, including `availableAt` at the
 * lease end. The delivery claim is keyed on `availableAt`, so a row seeded
 * that way is kept out by its due time alone and says nothing about the lease
 * comparison. That comparison is what still guards a row an older release
 * claimed without moving `availableAt` (a rolling deploy), which is why the
 * delivery queue has a third case seeded exactly like that.
 */
const prisma = createPrismaClient();

let pipeline: import("@/shared/notifications/notification-pipeline-service").NotificationPipelineService;

const BUSINESS = "018fc000-0000-7000-8000-0000000005b1";
const RECIPIENT = "018fc000-0000-7000-8000-0000000005c1";

const mail = { sent: [] as Array<{ referenceId?: string }> };

async function createEvent(
  data: {
    status?: "PENDING" | "PROCESSING";
    attempts?: number;
    leaseExpiresAt?: Date | null;
    availableAt?: Date;
  } = {},
): Promise<string> {
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
      ...data,
    },
  });

  return event.id;
}

/**
 * An expanded event whose e-mail row is the only one left to send: every
 * other channel is settled, so what the external lane claims is exactly the
 * row under test.
 */
async function emailRow(): Promise<string> {
  const eventId = await createEvent();
  await pipeline.runOutboxCycle();

  await prisma.notificationDelivery.updateMany({
    where: { outboxEventId: eventId, channel: { not: "EMAIL" } },
    data: { status: "DELIVERED", deliveredAt: new Date() },
  });

  const row = await prisma.notificationDelivery.findFirstOrThrow({
    where: { outboxEventId: eventId, channel: "EMAIL" },
  });

  return row.id;
}

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: BUSINESS,
      corporate_reason: "Transportadora do Lease",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "22333444000282",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `lease-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.user.create({
    data: {
      id: RECIPIENT,
      name: "Pessoa Destinatária",
      email: `destinataria-lease-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: BUSINESS,
      whatsapp_phone: "5511999990000",
      whatsapp_notifications_enabled: true,
    },
  });

  // The container registrations (repositories, providers) come with the app.
  const { app } = await import("@/http");
  await app.ready();

  // After the app registered the real providers: the last registration wins.
  container.registerInstance("MailProvider", {
    sendMail: async (message: { referenceId?: string }) => {
      mail.sent.push(message);
      return { messageId: "<m@x>" };
    },
  });

  container.registerInstance("WhatsAppProvider", {
    isConfigured: () => true,
    sendMessage: async () => ({ success: true, messageId: "wamid.1" }),
  });

  const pipelineModule = await import(
    "@/shared/notifications/notification-pipeline-service"
  );

  pipeline = pipelineModule.NotificationPipelineService.getInstance();
}, 120_000);

beforeEach(async () => {
  mail.sent = [];

  await prisma.notificationDelivery.deleteMany({});
  await prisma.domainOutboxEvent.deleteMany({});
});

afterAll(async () => {
  await prisma.notificationDelivery.deleteMany({});
  await prisma.domainOutboxEvent.deleteMany({});
  await prisma.$disconnect();
}, 60_000);

describe("a delivery another replica is still sending", () => {
  it("is left alone until its lease runs out", async () => {
    const id = await emailRow();
    const leaseEnd = new Date(Date.now() + 60_000);

    // Replica A claimed it a moment ago and is talking to the provider now.
    await prisma.notificationDelivery.update({
      where: { id },
      data: {
        status: "PROCESSING",
        attempts: 1,
        leaseExpiresAt: leaseEnd,
        availableAt: leaseEnd,
      },
    });

    await pipeline.runDeliveryCycle("external");

    // Replica B sending it too is the second copy of the e-mail.
    expect(mail.sent).toHaveLength(0);

    const row = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { id },
    });

    expect(row.status).toBe("PROCESSING");
    expect(row.attempts).toBe(1);
  });

  it("is left alone while its lease lives, even when its due time has passed", async () => {
    const id = await emailRow();

    // Claimed by an older release, which wrote the lease but left
    // availableAt at the due time it was claimed at. Only the lease
    // comparison keeps this row from a second sender now.
    await prisma.notificationDelivery.update({
      where: { id },
      data: {
        status: "PROCESSING",
        attempts: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000),
        availableAt: new Date(Date.now() - 1_000),
      },
    });

    await pipeline.runDeliveryCycle("external");

    expect(
      mail.sent,
      "o e-mail saiu enquanto o dono ainda o enviava",
    ).toHaveLength(0);

    const row = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { id },
    });

    expect(row.status).toBe("PROCESSING");
    expect(row.attempts).toBe(1);
  });

  it("is taken over once the lease has run out, and sent once", async () => {
    const id = await emailRow();
    const leaseEnd = new Date(Date.now() - 60_000);

    // Replica A died holding it: the lease ran out a minute ago.
    await prisma.notificationDelivery.update({
      where: { id },
      data: {
        status: "PROCESSING",
        attempts: 1,
        leaseExpiresAt: leaseEnd,
        availableAt: leaseEnd,
      },
    });

    await pipeline.runDeliveryCycle("external");

    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].referenceId).toBe(id);

    const row = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { id },
    });

    expect(row.status).toBe("DELIVERED");
    expect(row.attempts).toBe(2);
  });
});

describe("an event another replica is still expanding", () => {
  it("is left alone until its lease runs out", async () => {
    const leaseEnd = new Date(Date.now() + 60_000);

    const eventId = await createEvent({
      status: "PROCESSING",
      attempts: 1,
      leaseExpiresAt: leaseEnd,
      availableAt: leaseEnd,
    });

    await pipeline.runOutboxCycle();

    // Expanding it here would race the owner's createMany — harmless only
    // for as long as the partial unique indexes exist.
    expect(
      await prisma.notificationDelivery.count({
        where: { outboxEventId: eventId },
      }),
    ).toBe(0);

    const event = await prisma.domainOutboxEvent.findUniqueOrThrow({
      where: { id: eventId },
    });

    expect(event.status).toBe("PROCESSING");
    expect(event.attempts).toBe(1);
  });

  it("is expanded once the lease has run out", async () => {
    const leaseEnd = new Date(Date.now() - 60_000);

    const eventId = await createEvent({
      status: "PROCESSING",
      attempts: 1,
      leaseExpiresAt: leaseEnd,
      availableAt: leaseEnd,
    });

    await pipeline.runOutboxCycle();

    const event = await prisma.domainOutboxEvent.findUniqueOrThrow({
      where: { id: eventId },
    });

    expect(event.status).toBe("PUBLISHED");
    expect(event.attempts).toBe(2);

    expect(
      await prisma.notificationDelivery.count({
        where: { outboxEventId: eventId },
      }),
    ).toBeGreaterThan(0);
  });
});
