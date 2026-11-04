import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { randomBytes, randomUUID } from "node:crypto";

import { container } from "tsyringe";

import { ExternalRecipientRepository } from "@/modules/delivery/repositories/external-recipient-repository";
import { InMemoryExternalRecipientRepository } from "@/modules/delivery/repositories/in-memory/in-memory-external-recipient-repository";
import { createPrismaClient } from "@/shared/database/database-client";

import { seedUser } from "./support/fleet-driver-seed";

/**
 * The opt-out state on the delivery's detail and its undo (contract C2 of
 * 03/11/2026), through the real routes, the outbox, the pipeline and
 * Postgres.
 *
 * "Parar de receber" stops the customer's phone and e-mail inside the
 * carrier (D38), and the product had no way back: support deleted the row.
 * The detail now says since when each channel stopped (messageOptOut), and
 * POST /delivery/reactivate-customer-messages undoes it for the recipient —
 * so the next messages of EVERY delivery to that person go out again. The
 * dispatcher's, never the driver's; another tenant cannot reach it; pressing
 * it twice is harmless.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];
let pipeline: import("@/shared/notifications/notification-pipeline-service").NotificationPipelineService;

const CARRIER = "018fb800-0000-7000-8000-0000000008a1";
const OTHER = "018fb800-0000-7000-8000-0000000008a2";
const SHIPPERS: Record<string, string> = {
  [CARRIER]: "018fb800-0000-7000-8000-0000000008b1",
  [OTHER]: "018fb800-0000-7000-8000-0000000008b2",
};

const tokens = { admin: "", otherAdmin: "", driver: "" };
let adminId = "";

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
      email: `reactivate-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.businessEntitlement.create({
    data: { businessId: id, module: "DELIVERIES", enabled: true },
  });

  await prisma.shipper.create({
    data: { id: SHIPPERS[id], name: "Embarcador", businessId: id },
  });

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

async function dispatch(deliveryId: string, businessId: string) {
  await prisma.domainOutboxEvent.create({
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
      },
    },
  });
}

async function drain(): Promise<void> {
  await pipeline.runOutboxCycle();
  await pipeline.runDeliveryCycle("external");
}

// Each click from an address of its own: the public route's limiter lives
// in the Redis every E2E file shares.
const optOut = (token: string) =>
  app.inject({
    method: "POST",
    url: `/public/track/${token}/opt-out`,
    remoteAddress: `10.39.${randomBytes(1)[0]}.${(randomBytes(1)[0] % 250) + 1}`,
  });

const detail = (deliveryId: string, businessId = CARRIER) =>
  app.inject({
    method: "GET",
    url: `/delivery/get-delivery/${deliveryId}/business/${businessId}`,
    headers: { authorization: `Bearer ${tokens.admin}` },
  });

const reactivate = (deliveryId: string, token: string, businessId = CARRIER) =>
  app.inject({
    method: "POST",
    url: `/delivery/reactivate-customer-messages/${deliveryId}/business/${businessId}`,
    headers: { authorization: `Bearer ${token}` },
  });

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

beforeAll(async () => {
  await seedCarrier(CARRIER, "44555666000181");
  await seedCarrier(OTHER, "44555666000262");

  const admin = await seedUser(prisma, CARRIER, "BUSINESS_ADMIN");
  adminId = admin.id;
  tokens.admin = admin.token;
  tokens.otherAdmin = (await seedUser(prisma, OTHER, "BUSINESS_ADMIN")).token;

  const driver = await prisma.driver.create({
    data: {
      name: "Motorista",
      birth_date: new Date("1990-01-01"),
      cnh: randomUUID().replace(/-/g, "").slice(0, 11),
      cpf: randomUUID().slice(0, 14),
      rg: randomUUID().slice(0, 12),
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: CARRIER,
    },
  });
  tokens.driver = (
    await seedUser(prisma, CARRIER, "BUSINESS_USER", driver.id)
  ).token;

  ({ app } = await import("@/http"));
  await app.ready();

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

describe("opting out and reactivating from the delivery", () => {
  const contact = {
    telephone: "(11) 97777-5005",
    email: "Maria.Reativa@Exemplo.com.br",
  };

  let clicked = "";
  let next = "";

  it("shows on the detail since when each channel stopped, null while receiving", async () => {
    clicked = await seedDelivery(CARRIER, contact);
    // The same person on the next NF-e, typed another way.
    next = await seedDelivery(CARRIER, {
      telephone: "011 97777-5005",
      email: " maria.reativa@exemplo.com.br",
    });

    const before = await detail(next);

    expect(before.statusCode, before.body).toBe(200);
    expect(before.json().data.messageOptOut).toEqual({
      whatsapp: null,
      email: null,
    });

    expect(
      (await optOut(await trackingToken(clicked, CARRIER, contact))).statusCode,
    ).toBe(200);

    for (const id of [clicked, next]) {
      const state = (await detail(id)).json().data.messageOptOut;

      expect(state.whatsapp).toMatch(ISO);
      expect(state.email).toMatch(ISO);
    }
  });

  it("is refused to a driver, and changes nothing", async () => {
    const response = await reactivate(next, tokens.driver);

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("DRIVER_CANNOT_MANAGE_DELIVERIES");
    expect(
      await prisma.customerMessageSuppression.count({
        where: { businessId: CARRIER },
      }),
    ).toBe(2);
  });

  it("cannot be reached by another tenant", async () => {
    // Naming the company in the path: the tenant guard.
    const named = await reactivate(next, tokens.otherAdmin);

    expect(named.statusCode).toBe(403);

    // Its own company in the path: the delivery is not there.
    const own = await reactivate(next, tokens.otherAdmin, OTHER);

    expect(own.statusCode).toBe(404);
    expect(own.json().code).toBe("DELIVERY_NOT_FOUND");

    expect(
      await prisma.customerMessageSuppression.count({
        where: { businessId: CARRIER },
      }),
    ).toBe(2);
  });

  it("lets the messages of both deliveries to that person flow again", async () => {
    // From the delivery that was NOT clicked.
    const response = await reactivate(next, tokens.admin);

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      data: { messageOptOut: { whatsapp: null, email: null } },
    });

    expect(
      await prisma.customerMessageSuppression.count({
        where: { businessId: CARRIER },
      }),
    ).toBe(0);
    expect(
      (
        await prisma.externalRecipient.findUniqueOrThrow({
          where: { deliveryId: clicked },
        })
      ).opted_out_at,
    ).toBeNull();

    for (const id of [clicked, next]) {
      expect((await detail(id)).json().data.messageOptOut).toEqual({
        whatsapp: null,
        email: null,
      });
    }

    await dispatch(clicked, CARRIER);
    await dispatch(next, CARRIER);
    await drain();

    expect(whatsapp.sent).toHaveLength(2);
    expect(mail.sent).toHaveLength(2);

    const activities = await prisma.activity.findMany({
      where: {
        businessId: CARRIER,
        description: "Mensagens ao cliente reativadas",
      },
    });

    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      entityId: next,
      performedBy: adminId,
    });
  });

  it("answers the same a second time, with nothing written", async () => {
    const response = await reactivate(next, tokens.admin);

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({
      messageOptOut: { whatsapp: null, email: null },
    });
    expect(
      await prisma.activity.count({
        where: {
          businessId: CARRIER,
          description: "Mensagens ao cliente reativadas",
        },
      }),
    ).toBe(1);
  });

  it("leaves another carrier's opt-out of the same person in place", async () => {
    const foreign = await seedDelivery(OTHER, contact);

    await optOut(await trackingToken(foreign, OTHER, contact));

    const again = await seedDelivery(CARRIER, contact);
    await optOut(await trackingToken(again, CARRIER, contact));

    expect((await reactivate(again, tokens.admin)).statusCode).toBe(200);

    expect(
      await prisma.customerMessageSuppression.count({
        where: { businessId: OTHER },
      }),
    ).toBe(2);
    expect(
      (
        await prisma.externalRecipient.findUniqueOrThrow({
          where: { deliveryId: foreign },
        })
      ).opted_out_at,
    ).toBeInstanceOf(Date);
  });
});

describe("the repository and its twin", () => {
  it("agree on the state and on what the undo clears", async () => {
    const real = new ExternalRecipientRepository(prisma);
    const twin = new InMemoryExternalRecipientRepository();

    const contact = {
      telephone: "(41) 95555-6006",
      email: "Pedro.Reativa@Exemplo.com.br",
    };

    const first = await seedDelivery(CARRIER, contact);
    const second = await seedDelivery(CARRIER, {
      telephone: "41955556006",
      email: "pedro.reativa@exemplo.com.br",
    });
    const foreign = await seedDelivery(OTHER, contact);

    for (const [id, businessId] of [
      [first, CARRIER],
      [second, CARRIER],
      [foreign, OTHER],
    ]) {
      twin.deliveryCompanies.set(id, businessId);
      twin.deliveryStates.set(id, {
        status: "IN_TRANSIT",
        name: "Pedro",
        ...(id === second
          ? {
              telephone: "41955556006",
              email: "pedro.reativa@exemplo.com.br",
            }
          : contact),
      });
    }

    const outcomes = [];

    for (const repository of [real, twin]) {
      const recipient = await repository.ensureForDelivery({
        deliveryId: first,
        businessId: CARRIER,
        name: "Pedro",
        ...contact,
      });
      await repository.optOut(recipient.access_token);

      const foreignRecipient = await repository.ensureForDelivery({
        deliveryId: foreign,
        businessId: OTHER,
        name: "Pedro",
        ...contact,
      });
      await repository.optOut(foreignRecipient.access_token);

      const stateBefore = await repository.messageOptOutState(CARRIER, second);
      const notOurs = await repository.messageOptOutState(CARRIER, foreign);
      const undo = await repository.reactivateCustomerMessages(CARRIER, second);
      const again = await repository.reactivateCustomerMessages(
        CARRIER,
        second,
      );
      const missing = await repository.reactivateCustomerMessages(
        CARRIER,
        foreign,
      );
      const stateAfter = await repository.messageOptOutState(CARRIER, second);
      const otherCarrier = await repository.suppressedChannels(OTHER, contact);

      outcomes.push({
        stopped: {
          whatsapp: stateBefore?.whatsapp instanceof Date,
          email: stateBefore?.email instanceof Date,
        },
        notOurs,
        undo,
        again,
        missing,
        stateAfter,
        otherCarrier: [...otherCarrier].sort(),
      });
    }

    expect(outcomes[0]).toEqual({
      stopped: { whatsapp: true, email: true },
      notOurs: null,
      undo: { removedSuppressions: 2, clearedOptOuts: 1 },
      again: { removedSuppressions: 0, clearedOptOuts: 0 },
      missing: null,
      stateAfter: { whatsapp: null, email: null },
      otherCarrier: ["EMAIL", "WHATSAPP"],
    });
    expect(outcomes[1]).toEqual(outcomes[0]);
  });
});
