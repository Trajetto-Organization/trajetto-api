import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { container } from "tsyringe";

/**
 * The customer's messages, in the order that is still true.
 *
 * "Saiu para entrega", "entregue" and "não entregue" are three events, each
 * retried on its own schedule. A "saiu" held back by a provider hiccup (30 s,
 * 2 min, 10 min of backoff) used to go out AFTER the "entregue" that followed
 * it: the customer read that the delivery had left after reading that it had
 * arrived. Each attempt now asks the delivery first, and a message the
 * delivery has moved past is dropped with the reason (GAP2-5).
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];
let pipeline: import("@/shared/notifications/notification-pipeline-service").NotificationPipelineService;

const BUSINESS = "018fc000-0000-7000-8000-000000000ed1";
const SHIPPER = "018fc000-0000-7000-8000-000000000ed2";

const whatsapp = {
  sent: [] as Array<{
    phoneNumber: string;
    referenceId?: string;
    audience?: string;
    message: string;
  }>,
};

async function seedDelivery(
  status: "PENDING" | "IN_TRANSIT" | "DELIVERED",
): Promise<string> {
  const delivery = await prisma.delivery.create({
    data: {
      businessId: BUSINESS,
      shipperId: SHIPPER,
      code: `PED-${randomUUID().slice(0, 8)}`,
      recipient_name: "Padaria Central",
      recipient_telephone: "11999990000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      status,
    },
  });

  return delivery.id;
}

async function dispatch(deliveryId: string): Promise<string> {
  const event = await prisma.domainOutboxEvent.create({
    data: {
      eventKey: `delivery.dispatched:${randomUUID()}`,
      topic: "delivery.dispatched",
      aggregateType: "delivery",
      aggregateId: deliveryId,
      businessId: BUSINESS,
      actorId: null,
      payload: {
        deliveryId,
        businessId: BUSINESS,
        recipientName: "Padaria Central",
        recipientEmail: null,
        recipientTelephone: "11999990000",
        invoiceNumber: "12345",
        code: "PED-1",
        city: "São Paulo",
        uf: "SP",
        scheduledDate: null,
        deliveredAt: null,
        receivedBy: null,
      },
    },
  });

  return event.id;
}

async function whatsAppRowOf(eventId: string) {
  return prisma.notificationDelivery.findFirstOrThrow({
    where: { outboxEventId: eventId, channel: "WHATSAPP" },
  });
}

async function drain(): Promise<void> {
  await pipeline.runOutboxCycle();
  await pipeline.runDeliveryCycle("external");
}

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: BUSINESS,
      corporate_reason: "Transportadora da Ordem",
      fantasy_name: "Ordem Log",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "22333444000942",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `ordem-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.shipper.create({
    data: { id: SHIPPER, name: "Embarcador", businessId: BUSINESS },
  });

  await prisma.deliveryMessageTemplate.create({
    data: {
      businessId: BUSINESS,
      topic: "DISPATCHED",
      channel: "WHATSAPP",
      body: "Sua entrega saiu. {{link}} Sair: {{link_descadastro}}",
    },
  });

  ({ app } = await import("@/http"));
  await app.ready();

  container.registerInstance("WhatsAppProvider", {
    isConfigured: () => true,
    sendMessage: async (props: (typeof whatsapp.sent)[number]) => {
      whatsapp.sent.push(props);
      return { success: true, messageId: "wamid.ordem" };
    },
  });

  pipeline = (
    await import("@/shared/notifications/notification-pipeline-service")
  ).NotificationPipelineService.getInstance();
}, 120_000);

beforeEach(() => {
  whatsapp.sent = [];
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.domainOutboxEvent.deleteMany({ where: { businessId: BUSINESS } });
  await prisma.externalRecipient.deleteMany({ where: { businessId: BUSINESS } });
  await prisma.delivery.deleteMany({ where: { businessId: BUSINESS } });
  await prisma.deliveryMessageTemplate.deleteMany({ where: { businessId: BUSINESS } });
  await prisma.shipper.deleteMany({ where: { businessId: BUSINESS } });
  await prisma.business.deleteMany({ where: { id: BUSINESS } });

  await app?.close();
  await prisma.$disconnect();
}, 60_000);

describe("a customer message the delivery has moved past", () => {
  it("is not sent: 'saiu para entrega' after the delivery was delivered", async () => {
    const eventId = await dispatch(await seedDelivery("DELIVERED"));

    await drain();

    expect(
      whatsapp.sent.filter((sent) => sent.message.includes("Sua entrega saiu")),
    ).toEqual([]);

    const row = await whatsAppRowOf(eventId);

    expect(row.status).toBe("FAILED");
    expect(row.attempts).toBe(1);
    expect(row.lastError).toMatch(/superada/);
  });

  it("is not sent: 'saiu para entrega' after the load came back to the pool", async () => {
    // The route was cancelled after departure with this stop open: its
    // delivery went back to PENDING (route-repository mirrorOntoDeliveries)
    // while the "saiu" waited in backoff. The truck is not coming.
    const eventId = await dispatch(await seedDelivery("PENDING"));

    await drain();

    expect(
      whatsapp.sent.filter((sent) => sent.message.includes("Sua entrega saiu")),
    ).toEqual([]);

    const row = await whatsAppRowOf(eventId);

    expect(row.status).toBe("FAILED");
    expect(row.lastError).toMatch(/superada: a entrega está PENDING/);
  });

  it("is still sent while it is true, under the customer template", async () => {
    const deliveryId = await seedDelivery("IN_TRANSIT");
    const eventId = await dispatch(deliveryId);

    await drain();

    const row = await whatsAppRowOf(eventId);

    expect(row.status).toBe("DELIVERED");

    const sent = whatsapp.sent.filter((entry) => entry.referenceId === row.id);

    expect(sent).toHaveLength(1);
    expect(sent[0].audience).toBe("customer");
  });
});
