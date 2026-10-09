import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { container } from "tsyringe";

/**
 * A company template that cannot be rendered, met by the real pipeline.
 *
 * The save now refuses anything outside the published variable set, but a row
 * written before that check (or by any path that skips it) still reaches the
 * worker. Rendering it used to throw a plain Error — a Handlebars parse error
 * or "partial could not be found" — which the pipeline reads as transient:
 * five attempts, thirty seconds to thirty minutes apart, all certain to fail
 * the same way, and the customer told nothing either way. And `{{log}}` did
 * not fail at all: it printed the tenant's line into the platform's log on
 * every send.
 *
 * A template that cannot render is a decision the company has to fix, so the
 * delivery fails on its first attempt, with a reason a master can read.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];
let pipeline: import("@/shared/notifications/notification-pipeline-service").NotificationPipelineService;

const BUSINESS = "018fc000-0000-7000-8000-0000000007b1";
const SHIPPER = "018fc000-0000-7000-8000-0000000007c1";

const mail = { sent: [] as Array<{ to: string }> };

async function seedDelivery(): Promise<string> {
  const delivery = await prisma.delivery.create({
    data: {
      businessId: BUSINESS,
      shipperId: SHIPPER,
      code: `PED-${randomUUID().slice(0, 8)}`,
      recipient_name: "Padaria Central",
      recipient_email: "contato@padaria.exemplo",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      // Out for delivery, as every "saiu" finds it: start-route publishes it
      // only for the deliveries its departure moved to IN_TRANSIT, and a
      // PENDING one is a load back in the pool, whose "saiu" is dropped as
      // superseded (customer-message-order.test.ts).
      status: "IN_TRANSIT",
    },
  });

  return delivery.id;
}

async function useTemplate(body: string): Promise<void> {
  // Written straight to the table: this is the row the save would refuse
  // today, as it sits in a database that accepted it before.
  await prisma.deliveryMessageTemplate.upsert({
    where: {
      businessId_topic_channel: {
        businessId: BUSINESS,
        topic: "DISPATCHED",
        channel: "EMAIL",
      },
    },
    create: {
      businessId: BUSINESS,
      topic: "DISPATCHED",
      channel: "EMAIL",
      subject: "Sua entrega saiu",
      body,
    },
    update: { body },
  });
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
        recipientEmail: "contato@padaria.exemplo",
        recipientTelephone: null,
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

async function externalEmailOf(eventId: string) {
  return prisma.notificationDelivery.findFirstOrThrow({
    where: {
      outboxEventId: eventId,
      channel: "EMAIL",
      externalRecipientId: { not: null },
    },
  });
}

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: BUSINESS,
      corporate_reason: "Transportadora do Template",
      fantasy_name: "Silva Log",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "22333444000177",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `template-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.shipper.create({
    data: { id: SHIPPER, name: "Embarcador", businessId: BUSINESS },
  });

  ({ app } = await import("@/http"));
  await app.ready();

  container.registerInstance("MailProvider", {
    sendMail: async (message: { to: string }) => {
      mail.sent.push(message);
      return { messageId: "<m@x>" };
    },
  });

  const pipelineModule = await import(
    "@/shared/notifications/notification-pipeline-service"
  );

  pipeline = pipelineModule.NotificationPipelineService.getInstance();
}, 120_000);

beforeEach(() => {
  mail.sent = [];
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.notificationDelivery.deleteMany({});
  await prisma.domainOutboxEvent.deleteMany({});
  await prisma.externalRecipient.deleteMany({ where: { businessId: BUSINESS } });
  await prisma.delivery.deleteMany({ where: { businessId: BUSINESS } });
  await prisma.deliveryMessageTemplate.deleteMany({ where: { businessId: BUSINESS } });
  await prisma.shipper.deleteMany({ where: { businessId: BUSINESS } });
  await prisma.business.deleteMany({ where: { id: BUSINESS } });

  await app?.close();
  await prisma.$disconnect();
}, 60_000);

async function drain(): Promise<void> {
  await pipeline.runOutboxCycle();
  await pipeline.runDeliveryCycle("external");
}

describe("a company template the pipeline cannot render", () => {
  it("fails on the first attempt instead of retrying a certain failure", async () => {
    await useTemplate("Saiu {{#if destinatario}}{{destinatario}} {{link}}");

    const eventId = await dispatch(await seedDelivery());

    await drain();

    const row = await externalEmailOf(eventId);

    expect(row.status, `lastError: ${row.lastError}`).toBe("FAILED");
    expect(row.attempts).toBe(1);
    expect(row.lastError).toMatch(/template/i);

    expect(mail.sent).toEqual([]);
  });

  it("never runs {{log}}, and never prints the tenant's line", async () => {
    const printed: string[] = [];

    for (const level of ["error", "warn", "info", "log", "debug"] as const) {
      const original = console[level].bind(console);

      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        printed.push(args.map(String).join(" "));
        original(...args);
      });
    }

    await useTemplate('{{log "[ERROR] FORGED: pagamento estornado" level="error"}} {{link}}');

    const eventId = await dispatch(await seedDelivery());

    await drain();

    const row = await externalEmailOf(eventId);

    expect(row.status, `lastError: ${row.lastError}`).toBe("FAILED");
    expect(row.attempts).toBe(1);

    expect(printed.filter((line) => line.includes("FORGED"))).toEqual([]);
    expect(mail.sent).toEqual([]);
  });

  it("still sends a template that uses only the published variables", async () => {
    await useTemplate("Olá {{destinatario}}, sua entrega saiu. {{link}}");

    const eventId = await dispatch(await seedDelivery());

    await drain();

    const row = await externalEmailOf(eventId);

    expect(row.status, `lastError: ${row.lastError}`).toBe("DELIVERED");
    expect(mail.sent).toHaveLength(1);
  });
});
