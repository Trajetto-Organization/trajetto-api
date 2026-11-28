import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { container } from "tsyringe";

import { createPrismaClient } from "@/shared/database/database-client";

/**
 * What a customer e-mail is written to, through the outbox, the pipeline and
 * Postgres.
 *
 * The NF-e and spreadsheet imports stored the recipient's e-mail field
 * unchecked, and the pipeline handed the stored text to nodemailer's address
 * parser as is. The imports now keep only the valid addresses of a list
 * separated by ";" or "," (recipient-email.ts); the send reads the stored
 * value the same way, so a row written before that rule reaches the
 * transport only with its valid addresses — and one with none never becomes
 * an e-mail row.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];
let pipeline: import("@/shared/notifications/notification-pipeline-service").NotificationPipelineService;

const CARRIER = "018fc000-0000-7000-8000-000000000e51";
const SHIPPER = "018fc000-0000-7000-8000-000000000e52";

const mail = { sent: [] as Array<{ to: string }> };
const whatsapp = { sent: [] as Array<{ phoneNumber: string }> };

async function seedDelivery(email: string): Promise<string> {
  // Written straight to the column, as an import did before the rule.
  const delivery = await prisma.delivery.create({
    data: {
      businessId: CARRIER,
      shipperId: SHIPPER,
      code: `PED-${randomUUID().slice(0, 8)}`,
      recipient_name: "Maria Souza",
      recipient_telephone: "(11) 98888-3003",
      recipient_email: email,
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      status: "IN_TRANSIT",
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
      businessId: CARRIER,
      actorId: null,
      payload: {
        deliveryId,
        businessId: CARRIER,
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
      },
    },
  });

  return event.id;
}

async function customerRowsOf(eventId: string) {
  return prisma.notificationDelivery.findMany({
    where: { outboxEventId: eventId, externalRecipientId: { not: null } },
    orderBy: { channel: "asc" },
  });
}

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora E-mails",
      fantasy_name: "Log E-mails",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "33444555000424",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `emails-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.shipper.create({
    data: { id: SHIPPER, name: "Embarcador", businessId: CARRIER },
  });

  // "Saiu para entrega" on both channels: the e-mail with the company's
  // text, the WhatsApp row as the on/off switch (B3).
  await prisma.deliveryMessageTemplate.createMany({
    data: [
      {
        businessId: CARRIER,
        topic: "DISPATCHED",
        channel: "EMAIL",
        subject: "Sua entrega saiu",
        body: "Olá {{destinatario}}, sua entrega saiu. {{link}}",
      },
      { businessId: CARRIER, topic: "DISPATCHED", channel: "WHATSAPP" },
    ],
  });

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

  const pipelineModule =
    await import("@/shared/notifications/notification-pipeline-service");

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

describe("a customer e-mail", () => {
  it("goes to every valid address of a ';' list, once each, and to nothing else", async () => {
    const delivery = await seedDelivery(
      "compras@cliente.com.br; nao-e-email ;Financeiro@Cliente.com.br;COMPRAS@cliente.com.br;",
    );
    const eventId = await dispatch(delivery);

    await drain();

    expect(mail.sent.map((sent) => sent.to)).toEqual([
      "compras@cliente.com.br, Financeiro@Cliente.com.br",
    ]);
    expect(
      (await customerRowsOf(eventId)).map((row) => row.status).sort(),
    ).toEqual(["DELIVERED", "DELIVERED"]);
  });

  it("still goes to both addresses of a ',' list stored before the rule, as nodemailer 6 sent it", async () => {
    // A list pasted from a mail client, imported unchecked: the release must
    // not silence it.
    const delivery = await seedDelivery(
      "Nome <nome@cliente.com.br>, compras@cliente.com.br , vendas@cliente.com.br",
    );
    const eventId = await dispatch(delivery);

    await drain();

    // The display-name form is no address the manual create takes: left out.
    expect(mail.sent.map((sent) => sent.to)).toEqual([
      "compras@cliente.com.br, vendas@cliente.com.br",
    ]);
    expect(
      (await customerRowsOf(eventId)).map((row) => row.status).sort(),
    ).toEqual(["DELIVERED", "DELIVERED"]);
  });

  it("is never queued for a field with no valid address; the WhatsApp still goes", async () => {
    // The shape that stalled the parser for seconds per send
    // (GHSA-2x7j-588g-ccc2): only the first entries are read, none an address.
    const delivery = await seedDelivery("a,".repeat(40_000));
    const eventId = await dispatch(delivery);

    await drain();

    expect(mail.sent).toEqual([]);
    expect(whatsapp.sent).toHaveLength(1);

    const rows = await customerRowsOf(eventId);

    expect(rows.map((row) => row.channel)).toEqual(["WHATSAPP"]);
  });

  it("drops a queued message whose address was corrected to an invalid one", async () => {
    const delivery = await seedDelivery("maria@cliente.com.br");
    const eventId = await dispatch(delivery);

    // Expanded while the address was good: both rows are waiting.
    await pipeline.runOutboxCycle();

    await prisma.externalRecipient.update({
      where: { deliveryId: delivery },
      data: { email: "maria@" },
    });

    await pipeline.runDeliveryCycle("external");

    expect(mail.sent).toEqual([]);

    const email = (await customerRowsOf(eventId)).find(
      (row) => row.channel === "EMAIL",
    );

    expect(email).toMatchObject({ status: "FAILED" });
    expect(email?.lastError).toContain("no valid e-mail address");
  });
});
