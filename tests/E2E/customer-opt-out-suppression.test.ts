import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { randomBytes, randomUUID } from "node:crypto";

import { container } from "tsyringe";

import { ExternalRecipientRepository } from "@/modules/delivery/repositories/external-recipient-repository";
import { InMemoryExternalRecipientRepository } from "@/modules/delivery/repositories/in-memory/in-memory-external-recipient-repository";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * "Parar de receber" by phone and e-mail inside the carrier (plan of
 * 02/11/2026, B5, decision D38), through the real public route, the outbox,
 * the pipeline and Postgres.
 *
 * The opt-out used to stop only the delivery whose link was clicked
 * (ExternalRecipient.opted_out_at): somebody who receives many deliveries
 * from the same carrier got the next one's WhatsApp and e-mail anyway. Now
 * the click also records the recipient's normalized phone and e-mail for that
 * carrier, in the same transaction, and every customer message checks it when
 * it is expanded and again when it is sent — so a message already queued is
 * dropped. Another carrier is not affected, and neither is another tenant's
 * token.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];
let pipeline: import("@/shared/notifications/notification-pipeline-service").NotificationPipelineService;

const CARRIER = "018fc000-0000-7000-8000-0000000008a1";
const OTHER = "018fc000-0000-7000-8000-0000000008a2";
const SHIPPERS: Record<string, string> = {
  [CARRIER]: "018fc000-0000-7000-8000-0000000008b1",
  [OTHER]: "018fc000-0000-7000-8000-0000000008b2",
};

const mail = { sent: [] as Array<{ to: string }> };
const whatsapp = { sent: [] as Array<{ phoneNumber: string }> };

async function seedCarrier(id: string, cnpj: string): Promise<void> {
  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${id.slice(-2)}`,
      fantasy_name: `Log ${id.slice(-2)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj,
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `optout-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.shipper.create({
    data: { id: SHIPPERS[id], name: "Embarcador", businessId: id },
  });

  // "Saiu para entrega" on both channels: the e-mail with the company's
  // text, the WhatsApp row as the on/off switch (B3).
  await prisma.deliveryMessageTemplate.createMany({
    data: [
      {
        businessId: id,
        topic: "DISPATCHED",
        channel: "EMAIL",
        subject: "Sua entrega saiu",
        body: "Olá {{destinatario}}, sua entrega saiu. {{link}}",
      },
      { businessId: id, topic: "DISPATCHED", channel: "WHATSAPP" },
    ],
  });
}

async function seedDelivery(
  businessId: string,
  contact: { telephone: string; email: string },
): Promise<string> {
  const delivery = await prisma.delivery.create({
    data: {
      businessId,
      shipperId: SHIPPERS[businessId],
      code: `PED-${randomUUID().slice(0, 8)}`,
      recipient_name: "Maria Souza",
      recipient_telephone: contact.telephone,
      recipient_email: contact.email,
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      status: "IN_TRANSIT",
    },
  });

  return delivery.id;
}

/** The link the customer already holds for this delivery. */
async function trackingToken(
  deliveryId: string,
  businessId: string,
  contact: { telephone: string; email: string },
): Promise<string> {
  const recipient = await prisma.externalRecipient.create({
    data: {
      deliveryId,
      businessId,
      name: "Maria Souza",
      ...contact,
      access_token: randomBytes(32).toString("hex"),
    },
  });

  return recipient.access_token;
}

async function dispatch(
  deliveryId: string,
  businessId: string,
  stop?: { deliveries: string[] },
) {
  const event = await prisma.domainOutboxEvent.create({
    data: {
      eventKey: `delivery.dispatched:${randomUUID()}`,
      topic: "delivery.dispatched",
      aggregateType: "delivery",
      aggregateId: deliveryId,
      businessId,
      actorId: null,
      payload: {
        deliveryId,
        businessId,
        recipientName: "Maria Souza",
        recipientEmail: null,
        recipientTelephone: null,
        invoiceNumber: "12345",
        code: "PED-1",
        city: "São Paulo",
        uf: "SP",
        scheduledDate: null,
        deliveredAt: null,
        receivedBy: null,
        // One message for the stop's NF-e (B6), as OutboxService merges it.
        ...(stop
          ? {
              routeId: null,
              stopGroupKey: `stop-${randomUUID()}`,
              deliveries: stop.deliveries.map((id) => ({
                deliveryId: id,
                invoiceNumber: null,
                code: null,
              })),
            }
          : {}),
      },
    },
  });

  return event.id;
}

// The route allows 10 clicks a minute per client, counted in the Redis every
// E2E file and every rerun share: each click comes from an address of its
// own, so this file never spends another one's budget, nor its own last run's.
const optOut = (token: string) =>
  app.inject({
    method: "POST",
    url: `/public/track/${token}/opt-out`,
    remoteAddress: `10.38.${randomBytes(1)[0]}.${(randomBytes(1)[0] % 250) + 1}`,
  });

async function customerRowsOf(eventId: string) {
  return prisma.notificationDelivery.findMany({
    where: { outboxEventId: eventId, externalRecipientId: { not: null } },
    orderBy: { channel: "asc" },
  });
}

beforeAll(async () => {
  await seedCarrier(CARRIER, "33444555000181");
  await seedCarrier(OTHER, "33444555000262");

  ({ app } = await import("@/http"));
  await app.ready();

  // After the app registered the real providers: the last registration wins.
  container.registerInstance("MailProvider", {
    sendMail: async (message: { to: string }) => {
      mail.sent.push(message);
      return { messageId: `<${randomUUID()}@x>` };
    },
  });

  container.registerInstance("WhatsAppProvider", {
    isConfigured: () => true,
    sendMessage: async (props: { phoneNumber: string }) => {
      whatsapp.sent.push(props);
      return { success: true, messageId: `wamid.${randomUUID()}` };
    },
  });

  const pipelineModule = await import(
    "@/shared/notifications/notification-pipeline-service"
  );

  pipeline = pipelineModule.NotificationPipelineService.getInstance();
}, 120_000);

beforeEach(() => {
  mail.sent = [];
  whatsapp.sent = [];
});

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
}, 60_000);

async function drain(): Promise<void> {
  await pipeline.runOutboxCycle();
  await pipeline.runDeliveryCycle("external");
}

describe("an opt-out on one delivery", () => {
  const contact = {
    telephone: "(11) 98888-1001",
    email: "Maria@Exemplo.com.br",
  };

  it("stops the WhatsApp and the e-mail of the next delivery of the same carrier to that phone and e-mail", async () => {
    // Red before: only delivery A's recipient row was opted out; B was sent.
    const first = await seedDelivery(CARRIER, contact);
    const token = await trackingToken(first, CARRIER, contact);

    const response = await optOut(token);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ message: expect.any(String) });

    // Delivery B: the same person, the contact typed another way.
    const second = await seedDelivery(CARRIER, {
      telephone: "11988881001",
      email: " maria@exemplo.com.br",
    });
    const eventId = await dispatch(second, CARRIER);

    await drain();

    expect(whatsapp.sent).toEqual([]);
    expect(mail.sent).toEqual([]);
    // No row is even created: a skipped row shows as failed in every report.
    expect(await customerRowsOf(eventId)).toEqual([]);

    const stored = await prisma.customerMessageSuppression.findMany({
      where: { businessId: CARRIER },
      orderBy: { channel: "asc" },
    });

    expect(
      stored.map(({ channel, address, source_delivery_id }) => ({
        channel,
        address,
        source_delivery_id,
      })),
    ).toEqual([
      {
        channel: "WHATSAPP",
        address: "5511988881001",
        source_delivery_id: first,
      },
      {
        channel: "EMAIL",
        address: "maria@exemplo.com.br",
        source_delivery_id: first,
      },
    ]);
  });

  it("does not stop another carrier writing to the same phone and e-mail", async () => {
    const elsewhere = await seedDelivery(OTHER, contact);
    const eventId = await dispatch(elsewhere, OTHER);

    await drain();

    expect(whatsapp.sent.map((sent) => sent.phoneNumber)).toEqual([
      contact.telephone,
    ]);
    expect(mail.sent.map((sent) => sent.to)).toEqual([contact.email]);
    expect(
      (await customerRowsOf(eventId)).map((row) => row.status).sort(),
    ).toEqual(["DELIVERED", "DELIVERED"]);
  });

  it("answers a second click the same, and keeps one suppression per address", async () => {
    const delivery = await seedDelivery(CARRIER, contact);
    const token = await trackingToken(delivery, CARRIER, contact);

    const once = await optOut(token);
    const twice = await optOut(token);

    expect(twice.statusCode).toBe(once.statusCode);
    expect(twice.json()).toEqual(once.json());
    expect(
      await prisma.customerMessageSuppression.count({
        where: { businessId: CARRIER },
      }),
    ).toBe(2);
  });
});

describe("a message already queued when the person opts out", () => {
  it("is dropped at send time, with the reason recorded", async () => {
    const contact = {
      telephone: "(21) 97777-2002",
      email: "joao@exemplo.com.br",
    };

    const queued = await seedDelivery(CARRIER, contact);
    const eventId = await dispatch(queued, CARRIER);

    // Expanded before the click: both rows are waiting.
    await pipeline.runOutboxCycle();

    expect(
      (await customerRowsOf(eventId)).map((row) => row.status).sort(),
    ).toEqual(["PENDING", "PENDING"]);

    // The person opts out from another delivery's link.
    const clicked = await seedDelivery(CARRIER, contact);

    expect(
      (await optOut(await trackingToken(clicked, CARRIER, contact))).statusCode,
    ).toBe(200);

    await pipeline.runDeliveryCycle("external");

    expect(whatsapp.sent).toEqual([]);
    expect(mail.sent).toEqual([]);

    const rows = await customerRowsOf(eventId);

    expect(rows.map((row) => row.status)).toEqual(["FAILED", "FAILED"]);

    for (const row of rows) {
      expect(row.attempts).toBe(1);
      expect(row.lastError).toMatch(/descadastr|opted out|suppress/i);
    }
  });
});

describe("a phone typed another way on the next NF-e", () => {
  it("is the same line without the ninth digit or behind a trunk prefix", async () => {
    // The old customer record still has the 8-digit mobile; the next NF-e
    // carries the ninth digit, and another one the trunk "0" in front.
    const clicked = await seedDelivery(CARRIER, {
      telephone: "1187771005",
      email: "lucia@exemplo.com.br",
    });

    expect(
      (
        await optOut(
          await trackingToken(clicked, CARRIER, {
            telephone: "1187771005",
            email: "lucia@exemplo.com.br",
          }),
        )
      ).statusCode,
    ).toBe(200);

    const events = [];

    for (const telephone of ["11987771005", "011987771005"]) {
      const next = await seedDelivery(CARRIER, {
        telephone,
        email: "outra-lucia@exemplo.com.br",
      });

      events.push(await dispatch(next, CARRIER));
    }

    await drain();

    expect(whatsapp.sent).toEqual([]);

    for (const eventId of events) {
      // The e-mail is another address: it still goes.
      expect((await customerRowsOf(eventId)).map((row) => row.channel)).toEqual(
        ["EMAIL"],
      );
    }

    expect(
      await prisma.customerMessageSuppression.findMany({
        where: { businessId: CARRIER, source_delivery_id: clicked },
        select: { channel: true, address: true },
        orderBy: { channel: "asc" },
      }),
    ).toEqual([
      { channel: "WHATSAPP", address: "5511987771005" },
      { channel: "EMAIL", address: "lucia@exemplo.com.br" },
    ]);
  });
});

describe("one message for the stop's NF-e (B6)", () => {
  it("is dropped when queued and never created afterwards, the link being another delivery's", async () => {
    const contact = {
      telephone: "(51) 96666-5005",
      email: "Rosa@Exemplo.com.br",
    };

    // The visit's two NF-e; the first created is the anchor (lowest id).
    const anchor = await seedDelivery(CARRIER, contact);
    const sibling = await seedDelivery(CARRIER, contact);

    const queued = await dispatch(anchor, CARRIER, {
      deliveries: [anchor, sibling],
    });

    await pipeline.runOutboxCycle();

    const pending = await customerRowsOf(queued);

    expect(pending.map((row) => row.status)).toEqual(["PENDING", "PENDING"]);

    // The person opts out from last week's delivery, outside this stop.
    const lastWeek = await seedDelivery(CARRIER, contact);

    expect(
      (await optOut(await trackingToken(lastWeek, CARRIER, contact)))
        .statusCode,
    ).toBe(200);

    await pipeline.runDeliveryCycle("external");

    expect(whatsapp.sent).toEqual([]);
    expect(mail.sent).toEqual([]);

    const settled = await customerRowsOf(queued);

    expect(settled.map((row) => row.status)).toEqual(["FAILED", "FAILED"]);
    // The stop's message is written to the anchor's recipient row.
    expect(
      await prisma.externalRecipient.count({
        where: {
          id: { in: settled.map((row) => row.externalRecipientId!) },
          deliveryId: anchor,
        },
      }),
    ).toBe(1);

    // The stop's next moment creates no row at all.
    const next = await dispatch(anchor, CARRIER, {
      deliveries: [sibling, anchor],
    });

    await drain();

    expect(whatsapp.sent).toEqual([]);
    expect(mail.sent).toEqual([]);
    expect(await customerRowsOf(next)).toEqual([]);
  });
});

describe("an internal notification to the same phone and e-mail", () => {
  it("is never suppressed: the table is the customers' only", async () => {
    const shared = {
      telephone: "(11) 97777-1003",
      email: "ops-interno@exemplo.com.br",
    };

    // A customer of this carrier opts out with that phone and e-mail...
    const delivery = await seedDelivery(CARRIER, shared);

    expect(
      (await optOut(await trackingToken(delivery, CARRIER, shared))).statusCode,
    ).toBe(200);

    // ...which are also those of somebody on the carrier's own team.
    const staff = await prisma.user.create({
      data: {
        name: "Pessoa da Equipe",
        email: shared.email,
        password: "nao-usado",
        role: "BUSINESS_ADMIN",
        businessId: CARRIER,
        whatsapp_phone: "11977771003",
        whatsapp_notifications_enabled: true,
      },
    });

    const event = await prisma.domainOutboxEvent.create({
      data: {
        eventKey: `account-payable.created:${randomUUID()}`,
        topic: "account-payable.created",
        aggregateType: "account_payable",
        aggregateId: randomUUID(),
        businessId: CARRIER,
        actorId: staff.id,
        payload: {
          accountPayableId: randomUUID(),
          businessId: CARRIER,
          amount: 150,
          serviceOrderId: null,
          registrationUserId: staff.id,
        },
      },
    });

    // E-mail and WhatsApp go out on the provider lane, whoever reads them.
    await pipeline.runOutboxCycle();
    await pipeline.runDeliveryCycle("internal");
    await pipeline.runDeliveryCycle("external");

    expect(whatsapp.sent.map((sent) => sent.phoneNumber)).toEqual([
      "11977771003",
    ]);
    expect(mail.sent.map((sent) => sent.to)).toEqual([shared.email]);

    const rows = await prisma.notificationDelivery.findMany({
      where: {
        outboxEventId: event.id,
        channel: { in: ["EMAIL", "WHATSAPP"] },
      },
      orderBy: { channel: "asc" },
    });

    expect(rows.map((row) => `${row.channel}:${row.status}`)).toEqual([
      "EMAIL:DELIVERED",
      "WHATSAPP:DELIVERED",
    ]);
  });
});

describe("another tenant's link", () => {
  it("records the suppression for its own carrier only", async () => {
    const contact = {
      telephone: "(31) 96666-3003",
      email: "ana@exemplo.com.br",
    };

    const foreign = await seedDelivery(OTHER, contact);

    expect(
      (await optOut(await trackingToken(foreign, OTHER, contact))).statusCode,
    ).toBe(200);

    expect(
      await prisma.customerMessageSuppression.count({
        where: { businessId: CARRIER, address: "5531966663003" },
      }),
    ).toBe(0);

    // This carrier still writes to Ana.
    const own = await seedDelivery(CARRIER, contact);

    await dispatch(own, CARRIER);
    await drain();

    expect(whatsapp.sent.map((sent) => sent.phoneNumber)).toEqual([
      contact.telephone,
    ]);
    expect(mail.sent.map((sent) => sent.to)).toEqual([contact.email]);
  });
});

describe("the repository and its twin", () => {
  it("agree on the opt-out and on what it suppresses", async () => {
    const real = new ExternalRecipientRepository(prisma);
    const twin = new InMemoryExternalRecipientRepository();

    const contact = {
      telephone: "(41) 95555-4004",
      email: "Pedro@Exemplo.com.br",
    };

    const deliveryId = await seedDelivery(CARRIER, contact);

    const outcomes = [];

    for (const repository of [real, twin]) {
      const recipient = await repository.ensureForDelivery({
        deliveryId,
        businessId: CARRIER,
        name: "Pedro",
        ...contact,
      });

      const first = await repository.optOut(recipient.access_token);
      const second = await repository.optOut(recipient.access_token);
      const unknown = await repository.optOut("e".repeat(64));

      const sameCarrier = await repository.suppressedChannels(CARRIER, {
        telephone: "41955554004",
        email: "pedro@exemplo.com.br ",
      });
      const otherCarrier = await repository.suppressedChannels(OTHER, {
        telephone: "41955554004",
        email: "pedro@exemplo.com.br",
      });

      outcomes.push({
        first,
        second,
        unknown,
        sameCarrier: [...sameCarrier].sort(),
        otherCarrier: [...otherCarrier].sort(),
      });
    }

    expect(outcomes[0]).toEqual({
      first: true,
      second: false,
      unknown: false,
      sameCarrier: ["EMAIL", "WHATSAPP"],
      otherCarrier: [],
    });
    expect(outcomes[1]).toEqual(outcomes[0]);
  });
});
