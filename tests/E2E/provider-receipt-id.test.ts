import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { randomUUID } from "node:crypto";

import { createPrismaClient } from "@/shared/database/database-client";
import {
  recordExpoTickets,
  recordMetaStatuses,
} from "@/shared/notifications/provider-receipts";
import { receiptIdFor } from "@/shared/notifications/receipt-id";
import { recordResendEvent } from "@/shared/notifications/resend-receipts";
import { uuid7Instant } from "@/shared/time/uuid7-floor";

/**
 * Repeated provider reports once the ledger's unique is gone (plano-escala
 * F5-04).
 *
 * Meta and Svix (Resend) repeat whatever they did not see a 2xx for, and
 * two replicas can take the same callback. Wave 10 (F5-06) drops the unique
 * (provider, providerMessageId, status) that absorbed the repeats: the
 * receipts become partitioned by day on their id. This file drops it from
 * its own database, as that release will, and proves three reports of one
 * fact still make one row — the id is decided by the fact — and so do two
 * copies whose ids differ (one tied, one not; an untied one held at today
 * and repeated tomorrow), which the writers dedupe by the fact's key.
 */
const prisma = createPrismaClient();

const BUSINESS = "019a9a50-0000-7000-8000-000000000f01";
const USER = "019a9a50-0000-7000-8000-000000000f02";

async function seedDelivery(channel: "WHATSAPP" | "EMAIL" | "PUSH") {
  const event = await prisma.domainOutboxEvent.create({
    data: {
      eventKey: `receipt-id:${randomUUID()}`,
      topic: "account-payable.created",
      aggregateType: "account-payable",
      aggregateId: randomUUID(),
      businessId: BUSINESS,
      payload: {},
      status: "PUBLISHED",
    },
  });

  return prisma.notificationDelivery.create({
    data: {
      outboxEventId: event.id,
      userId: USER,
      channel,
      status: "DELIVERED",
      attempts: 1,
      deliveredAt: new Date(),
    },
  });
}

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: BUSINESS,
      corporate_reason: "Transportadora dos Recibos",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "44555666000172",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `receipt-id-${randomUUID()}@example.com`,
    },
  });

  await prisma.user.create({
    data: {
      id: USER,
      name: "Pessoa dos Recibos",
      email: `receipt-id-${randomUUID()}@example.com`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: BUSINESS,
    },
  });

  // What the daily partitions of wave 10 will not have.
  await prisma.$executeRawUnsafe(
    `DROP INDEX IF EXISTS "notification_provider_receipt_provider_providerMessageId_st_key"`,
  );
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
}, 60_000);

describe("without the unique (provider, providerMessageId, status)", () => {
  it("keeps three Meta callbacks of one fact as one row, under the delivery's day", async () => {
    const delivery = await seedDelivery("WHATSAPP");
    const wamid = `wamid.${randomUUID()}`;

    const report = (seconds: number) => ({
      providerMessageId: wamid,
      status: "delivered",
      occurredAt: new Date(Date.now() - seconds * 1000),
      deliveryId: delivery.id,
      errorCode: null,
      errorMessage: null,
    });

    await recordMetaStatuses([report(30)]);
    // Two replicas taking Meta's retries at once.
    await Promise.all([
      recordMetaStatuses([report(30)]),
      recordMetaStatuses([report(29)]),
    ]);

    const rows = await prisma.notificationProviderReceipt.findMany({
      where: { providerMessageId: wamid },
    });

    expect(rows).toHaveLength(1);
    expect(uuid7Instant(rows[0].id)).toBe(uuid7Instant(delivery.id));
    expect(rows[0].deliveryId).toBe(delivery.id);
  });

  it("keeps a repeat inside one callback body as one row", async () => {
    const wamid = `wamid.${randomUUID()}`;
    const report = {
      providerMessageId: wamid,
      status: "sent",
      occurredAt: new Date(),
      deliveryId: null,
      errorCode: null,
      errorMessage: null,
    };

    await recordMetaStatuses([report, { ...report }, { ...report }]);

    const rows = await prisma.notificationProviderReceipt.findMany({
      where: { providerMessageId: wamid },
    });

    // Untied: a wamid no delivery holds.
    expect(rows).toHaveLength(1);
    expect(rows[0].deliveryId).toBeNull();
    expect(rows[0].id).toBe(
      receiptIdFor({ ...report, provider: "meta" }, new Date()),
    );
  });

  it("keeps three Resend events of one fact as one row", async () => {
    const delivery = await seedDelivery("EMAIL");
    const emailId = randomUUID();

    const event = {
      status: "delivered",
      emailId,
      messageId: `<${delivery.id}@example.com>`,
      occurredAt: new Date(),
      errorCode: null,
      errorMessage: null,
    };

    await recordResendEvent(event);
    await recordResendEvent({ ...event });
    await recordResendEvent({ ...event });

    const rows = await prisma.notificationProviderReceipt.findMany({
      where: { providerMessageId: emailId },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].deliveryId).toBe(delivery.id);
  });

  // The id's anchor follows the tie: the delivery's millisecond when the
  // report is tied, midnight of occurredAt otherwise. A Meta status that
  // arrives before the worker recorded the wamid is untied; its repeat
  // after the commit is tied, and computes another id for the same fact.
  it("keeps a Meta status that was untied, then tied, as one row", async () => {
    const delivery = await seedDelivery("WHATSAPP");
    const wamid = `wamid.${randomUUID()}`;
    const report = {
      providerMessageId: wamid,
      status: "delivered",
      occurredAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      deliveryId: null,
      errorCode: null,
      errorMessage: null,
    };

    await recordMetaStatuses([report]);

    // The worker's commit lands between Meta's two copies.
    await prisma.notificationDelivery.update({
      where: { id: delivery.id },
      data: { providerMessageId: wamid },
    });

    await recordMetaStatuses([{ ...report }]);

    const rows = await prisma.notificationProviderReceipt.findMany({
      where: { providerMessageId: wamid },
    });

    expect(rows).toHaveLength(1);
    // The repeat still moves the delivery's status on.
    expect(
      (
        await prisma.notificationDelivery.findUniqueOrThrow({
          where: { id: delivery.id },
        })
      ).providerStatus,
    ).toBe("delivered");
  });

  it("keeps a tied and an untied copy taken at once by two replicas as one row", async () => {
    const delivery = await seedDelivery("WHATSAPP");
    const wamid = `wamid.${randomUUID()}`;
    const report = {
      providerMessageId: wamid,
      status: "read",
      occurredAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
      errorCode: null,
      errorMessage: null,
    };

    // One copy names the delivery in its callback data, the other names
    // nothing and its wamid is not recorded: two ids for one fact.
    await Promise.all([
      recordMetaStatuses([{ ...report, deliveryId: delivery.id }]),
      recordMetaStatuses([{ ...report, deliveryId: null }]),
    ]);

    expect(
      await prisma.notificationProviderReceipt.count({
        where: { providerMessageId: wamid },
      }),
    ).toBe(1);
  });

  // An untied report from a clock ahead of ours is held at today: its
  // repeat on another day computes another id.
  it("keeps an untied report repeated on another day as one row", async () => {
    const wamid = `wamid.${randomUUID()}`;
    const report = {
      providerMessageId: wamid,
      status: "sent",
      occurredAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      deliveryId: null,
      errorCode: null,
      errorMessage: null,
    };

    await recordMetaStatuses([report]);

    vi.useFakeTimers({ toFake: ["Date"] });

    try {
      vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000);

      await recordMetaStatuses([{ ...report }]);
    } finally {
      vi.useRealTimers();
    }

    expect(
      await prisma.notificationProviderReceipt.count({
        where: { providerMessageId: wamid },
      }),
    ).toBe(1);
  });

  it("keeps a Resend event that was untied, then tied, as one row", async () => {
    const delivery = await seedDelivery("EMAIL");
    const emailId = randomUUID();
    const event = {
      status: "delivered",
      emailId,
      // A Message-ID that names no delivery: tied only once the pipeline
      // has recorded Resend's id on the delivery.
      messageId: `<${randomUUID()}@example.com>`,
      occurredAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      errorCode: null,
      errorMessage: null,
    };

    await recordResendEvent(event);

    await prisma.notificationDelivery.update({
      where: { id: delivery.id },
      data: { providerMessageId: emailId },
    });

    await recordResendEvent({ ...event });

    expect(
      await prisma.notificationProviderReceipt.count({
        where: { providerMessageId: emailId },
      }),
    ).toBe(1);
  });

  it("keeps an Expo ticket recorded three times as one row", async () => {
    const delivery = await seedDelivery("PUSH");
    const ticket = { id: randomUUID(), token: "ExponentPushToken[receipt-id]" };

    await recordExpoTickets(delivery.id, [ticket]);
    await recordExpoTickets(delivery.id, [ticket]);
    await recordExpoTickets(delivery.id, [ticket]);

    expect(
      await prisma.notificationProviderReceipt.count({
        where: { providerMessageId: ticket.id },
      }),
    ).toBe(1);
  });
});
