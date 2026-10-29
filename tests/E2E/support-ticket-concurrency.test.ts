import "@/shared";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sign } from "jsonwebtoken";

import { randomUUID } from "node:crypto";

import auth from "@/config/auth";

import { SupportTicketRepository } from "@/modules/chat/repositories/support-ticket-repository";
import { ChatRepository } from "@/modules/chat/repositories/chat-repository";
import { DeliveryRepository } from "@/modules/delivery/repositories/delivery-repository";
import { UserRepository } from "@/modules/user/repositories/user-repository";
import { DriverRepository } from "@/modules/driver/repositories/driver-repository";
import { RepairUnticketedMessagesUseCase } from "@/modules/chat/usecases/tickets/repair-unticketed-messages/repair-unticketed-messages-usecase";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * What only the database can settle between replicas (design §7.3): the
 * per-company number under parallel creates, one open ticket per delivery
 * when two openers race, one decision when two operators close at once, and
 * the repair of messages the previous image wrote without a ticket.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fed00-0000-7000-8000-00000000000a";
const OTHER = "018fed00-0000-7000-8000-00000000000b";
const SHIPPER = "018fed00-0000-7000-8000-0000000000f1";
const DRIVER = "018fed00-0000-7000-8000-0000000000d1";
const FOREIGN_DRIVER = "018fed00-0000-7000-8000-0000000000d2";
const TOWER_TYPE = "018fed00-0000-7000-8000-0000000000e1";

const users = {} as Record<
  "admin" | "second" | "driver" | "otherAdmin",
  { id: string; token: string }
>;

let cnpjSeq = 0;

async function seedBusiness(id: string) {
  cnpjSeq += 1;

  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${id.slice(-1)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(52333555000180 + cnpjSeq),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${id}@exemplo.com.br`,
    },
  });

  await prisma.businessEntitlement.create({
    data: { businessId: id, module: "DELIVERIES", enabled: true },
  });
}

async function seedDriver(id: string, businessId: string) {
  await prisma.driver.create({
    data: {
      id,
      name: `Motorista ${id.slice(-2)}`,
      birth_date: new Date("1990-01-01"),
      cnh: `cnh-${id.slice(-4)}`,
      cpf: `cpf-${id.slice(-4)}`,
      rg: `rg-${id.slice(-4)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId,
    },
  });
}

async function seedUser(
  name: string,
  role: "BUSINESS_ADMIN" | "BUSINESS_USER",
  businessId: string,
  driverId: string | null = null,
) {
  const id = randomUUID();
  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id,
      name,
      email: `${id}@exemplo.com.br`,
      password: "x",
      role,
      businessId,
      driverId,
    },
  });

  await prisma.refreshToken.create({
    data: {
      userId: id,
      token_hash: randomUUID(),
      jti: randomUUID(),
      family_id: familyId,
      expires_in: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  return {
    id,
    token: sign(
      { tokenType: "access", sessionVersion: 0, familyId },
      auth.secret_token,
      {
        subject: id,
        expiresIn: "15m",
      },
    ),
  };
}

async function inTransit(
  recipient: string,
  businessId = CARRIER,
  driverId = DRIVER,
) {
  const shipperId =
    businessId === CARRIER
      ? SHIPPER
      : (
          await prisma.shipper.upsert({
            where: { id: "018fed00-0000-7000-8000-0000000000f2" },
            update: {},
            create: {
              id: "018fed00-0000-7000-8000-0000000000f2",
              name: "Outro",
              businessId,
            },
          })
        ).id;

  return (
    await prisma.delivery.create({
      data: {
        recipient_name: recipient,
        city: "São Paulo",
        uf: "SP",
        street: "Rua",
        businessId,
        shipperId,
        driverId,
        status: "IN_TRANSIT",
      },
    })
  ).id;
}

async function call(
  url: string,
  token: string,
  payload: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  const response = await app.inject({
    method: "POST",
    url,
    headers: { authorization: `Bearer ${token}`, ...headers },
    payload,
  });

  return { status: response.statusCode, body: response.json() };
}

beforeAll(async () => {
  await seedBusiness(CARRIER);
  await seedBusiness(OTHER);

  await prisma.shipper.create({
    data: { id: SHIPPER, name: "Embarcador", businessId: CARRIER },
  });

  await seedDriver(DRIVER, CARRIER);
  await seedDriver(FOREIGN_DRIVER, OTHER);

  users.admin = await seedUser("Ana Torre", "BUSINESS_ADMIN", CARRIER);
  users.second = await seedUser("Bruno Torre", "BUSINESS_ADMIN", CARRIER);
  users.driver = await seedUser(
    "João Motorista",
    "BUSINESS_USER",
    CARRIER,
    DRIVER,
  );
  users.otherAdmin = await seedUser("Outra Torre", "BUSINESS_ADMIN", OTHER);

  await prisma.occurrenceType.create({
    data: {
      id: TOWER_TYPE,
      name: "Cliente ausente",
      blocks_delivery: true,
      requires_authorization: true,
      businessId: CARRIER,
    },
  });

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("numbering per company", () => {
  it("numbers 20 parallel opens 1..20 with no hole nor repeat, and another company starts at 1", async () => {
    const answers = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        call(
          "/chat/tickets",
          users.admin.token,
          { driverId: DRIVER, subject: `Assunto paralelo ${index}` },
          { "idempotency-key": randomUUID() },
        ),
      ),
    );

    expect(answers.map((answer) => answer.status)).toEqual(Array(20).fill(201));

    const numbers = answers
      .map((answer) => answer.body.data.number)
      .sort((a, b) => a - b);

    expect(numbers).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );

    const foreign = await call(
      "/chat/tickets",
      users.otherAdmin.token,
      { driverId: FOREIGN_DRIVER, subject: "Primeiro da outra" },
      { "idempotency-key": randomUUID() },
    );

    expect(foreign.status, JSON.stringify(foreign.body)).toBe(201);
    expect(foreign.body.data.number).toBe(1);

    const counter = await prisma.supportTicketCounter.findUniqueOrThrow({
      where: { businessId: CARRIER },
    });

    expect(counter.last_number).toBe(20);
  });
});

describe("one open ticket per delivery", () => {
  it("converges two simultaneous opens for the same delivery on one ticket", async () => {
    const deliveryId = await inTransit("Corrida");

    const [a, b] = await Promise.all([
      call(
        "/chat/tickets",
        users.driver.token,
        { deliveryId },
        { "idempotency-key": randomUUID() },
      ),
      call(
        "/chat/tickets",
        users.admin.token,
        { driverId: DRIVER, deliveryId },
        { "idempotency-key": randomUUID() },
      ),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.data.id).toBe(b.body.data.id);
    expect([a.body.created, b.body.created].sort()).toEqual([false, true]);
    expect(
      await prisma.supportTicket.count({
        where: { deliveryId, status: "OPEN" },
      }),
    ).toBe(1);
  });
});

describe("two operators closing a request at once", () => {
  it("lets one decision win; the other hears who decided, and the delivery fails once", async () => {
    const deliveryId = await inTransit("Duelo");

    const reported = await call(
      `/delivery/report-occurrence/${deliveryId}/business/${CARRIER}`,
      users.driver.token,
      { occurrenceTypeId: TOWER_TYPE },
    );

    expect(reported.status, JSON.stringify(reported.body)).toBe(201);

    const ticketId = reported.body.data.ticket.id;

    const [approve, deny] = await Promise.all([
      call(`/chat/tickets/${ticketId}/close`, users.admin.token, {
        outcome: "APPROVED",
      }),
      call(`/chat/tickets/${ticketId}/close`, users.second.token, {
        outcome: "DENIED",
        note: "Não",
      }),
    ]);

    const statuses = [approve.status, deny.status].sort();

    expect(statuses).toEqual([200, 409]);

    const loser = approve.status === 409 ? approve : deny;

    expect([
      "OCCURRENCE_ALREADY_DECIDED",
      "SUPPORT_TICKET_ALREADY_CLOSED",
    ]).toContain(loser.body.code);

    const ticket = await prisma.supportTicket.findUniqueOrThrow({
      where: { id: ticketId },
    });
    const occurrence = await prisma.deliveryOccurrence.findUniqueOrThrow({
      where: { id: reported.body.data.id },
    });

    // The ticket closed once, with the decision that stands.
    expect(ticket.status).toBe("CLOSED");
    expect(ticket.close_outcome).toBe(occurrence.authorization_status);
    expect(
      await prisma.supportTicketEvent.count({
        where: { ticketId, type: "CLOSED" },
      }),
    ).toBe(1);

    if (occurrence.authorization_status === "APPROVED") {
      expect(
        await prisma.deliveryEvent.count({
          where: { deliveryId, type: "STATUS_CHANGE", status_to: "FAILED" },
        }),
      ).toBe(1);
    }
  });

  it("never leaves the decided occurrence's ticket open when the queue decides", async () => {
    const deliveryId = await inTransit("Fila");

    const reported = await call(
      `/delivery/report-occurrence/${deliveryId}/business/${CARRIER}`,
      users.driver.token,
      { occurrenceTypeId: TOWER_TYPE },
    );

    const ticketId = reported.body.data.ticket.id;

    const [fromQueue, fromTicket] = await Promise.all([
      call(
        `/delivery/occurrence-authorization/${reported.body.data.id}/business/${CARRIER}`,
        users.admin.token,
        { decision: "APPROVED" },
      ),
      call(`/chat/tickets/${ticketId}/close`, users.second.token, {
        outcome: "APPROVED",
      }),
    ]);

    expect([fromQueue.status, fromTicket.status]).toContain(200);

    const ticket = await prisma.supportTicket.findUniqueOrThrow({
      where: { id: ticketId },
    });

    expect(ticket.status).toBe("CLOSED");
    expect(
      await prisma.supportTicketEvent.count({
        where: { ticketId, type: "CLOSED" },
      }),
    ).toBe(1);
  });
});

describe("repair of messages without a ticket (rolling deploy)", () => {
  it("files a message the previous image wrote, once", async () => {
    const deliveryId = await inTransit("Imagem anterior");

    const thread = await prisma.chatThread.upsert({
      where: { businessId_driverId: { businessId: CARRIER, driverId: DRIVER } },
      update: {},
      create: { businessId: CARRIER, driverId: DRIVER },
    });

    const orphan = await prisma.chatMessage.create({
      data: {
        threadId: thread.id,
        senderId: users.driver.id,
        kind: "TEXT",
        body: "Escrita pela imagem anterior",
        deliveryId,
      },
    });

    const repair = () =>
      new RepairUnticketedMessagesUseCase(
        new SupportTicketRepository(),
        new ChatRepository(),
        new DeliveryRepository(),
        new UserRepository(),
        new DriverRepository(),
      ).execute();

    const [first, second] = await Promise.all([repair(), repair()]);

    expect(first + second).toBeGreaterThanOrEqual(1);

    const filed = await prisma.chatMessage.findUniqueOrThrow({
      where: { id: orphan.id },
    });

    expect(filed.ticketId).not.toBeNull();

    const ticket = await prisma.supportTicket.findUniqueOrThrow({
      where: { id: filed.ticketId! },
    });

    expect(ticket).toMatchObject({
      kind: "DELIVERY",
      deliveryId,
      opened_via: "LEGACY_ROUTING",
    });
    expect(ticket.last_driver_message_at?.getTime()).toBe(
      orphan.created_at.getTime(),
    );
    expect(await prisma.supportTicket.count({ where: { deliveryId } })).toBe(1);

    // Nothing left to do on the next run.
    expect(await repair()).toBe(0);
  });
});

describe("repair, judged like a live legacy send (review round 2)", () => {
  const repair = () =>
    new RepairUnticketedMessagesUseCase(
      new SupportTicketRepository(),
      new ChatRepository(),
      new DeliveryRepository(),
      new UserRepository(),
      new DriverRepository(),
    ).execute();

  async function threadId() {
    return (
      await prisma.chatThread.upsert({
        where: {
          businessId_driverId: { businessId: CARRIER, driverId: DRIVER },
        },
        update: {},
        create: { businessId: CARRIER, driverId: DRIVER },
      })
    ).id;
  }

  async function towerTicketWithReply(recipient: string) {
    const deliveryId = await inTransit(recipient);

    const opened = await call(
      "/chat/tickets",
      users.admin.token,
      { deliveryId },
      { "idempotency-key": randomUUID() },
    );
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);

    const reply = await call(
      `/chat/tickets/${opened.body.data.id}/messages`,
      users.admin.token,
      {
        kind: "TEXT",
        body: "Consegue confirmar o número?",
        clientSubmissionId: randomUUID(),
      },
    );
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);

    return {
      deliveryId,
      ticketId: opened.body.data.id as string,
      repliedAt: new Date(reply.body.data.created_at),
    };
  }

  it("files the driver's answer to the tower's message of the last 30 minutes in that ticket", async () => {
    const { ticketId, repliedAt } =
      await towerTicketWithReply("Resposta Reparada");

    // The old app's answer: no delivery, no route, a minute after the tower.
    const orphan = await prisma.chatMessage.create({
      data: {
        threadId: await threadId(),
        senderId: users.driver.id,
        kind: "TEXT",
        body: "É o 120",
        created_at: new Date(repliedAt.getTime() + 60_000),
      },
    });

    await repair();

    expect(
      (await prisma.chatMessage.findUniqueOrThrow({ where: { id: orphan.id } }))
        .ticketId,
    ).toBe(ticketId);
  });

  it("never moves a ticket back in the list order when it files an older message", async () => {
    const { deliveryId, ticketId, repliedAt } =
      await towerTicketWithReply("Ordem Reparada");
    // Older than the reply but after this database's backfill, which filed
    // everything before it (the repair never looks earlier).
    const backfilledAt =
      (await new SupportTicketRepository().ticketsBackfilledAt()) ??
      new Date(0);
    const writtenAt = new Date(
      Math.max(
        repliedAt.getTime() - 10 * 60_000,
        (backfilledAt.getTime() + repliedAt.getTime()) / 2,
      ),
    );

    const orphan = await prisma.chatMessage.create({
      data: {
        threadId: await threadId(),
        senderId: users.driver.id,
        kind: "TEXT",
        body: "Escrita antes, arquivada depois",
        deliveryId,
        created_at: writtenAt,
      },
    });

    await repair();

    const ticket = await prisma.supportTicket.findUniqueOrThrow({
      where: { id: ticketId },
    });

    expect(
      (await prisma.chatMessage.findUniqueOrThrow({ where: { id: orphan.id } }))
        .ticketId,
    ).toBe(ticketId);
    expect(ticket.last_message_at?.getTime()).toBe(repliedAt.getTime());
    expect(ticket.last_driver_message_at?.getTime()).toBe(
      orphan.created_at.getTime(),
    );
  });

  it("does not walk messages from before tickets existed, nor mass notices", async () => {
    const thread = await threadId();

    const ancient = await prisma.chatMessage.create({
      data: {
        threadId: thread,
        senderId: users.driver.id,
        kind: "TEXT",
        body: "De antes dos atendimentos",
        created_at: new Date("2026-09-01T12:00:00Z"),
      },
    });

    const notice = await prisma.chatMessage.create({
      data: {
        threadId: thread,
        senderId: users.admin.id,
        kind: "TEXT",
        body: "Aviso a todos",
        broadcast_id: randomUUID(),
      },
    });

    await repair();

    expect(
      (
        await prisma.chatMessage.findUniqueOrThrow({
          where: { id: ancient.id },
        })
      ).ticketId,
    ).toBeNull();
    expect(
      (await prisma.chatMessage.findUniqueOrThrow({ where: { id: notice.id } }))
        .ticketId,
    ).toBeNull();
  });
});
