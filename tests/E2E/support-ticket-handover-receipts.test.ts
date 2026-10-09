import "@/shared";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { sign } from "jsonwebtoken";

import { randomUUID } from "node:crypto";

import auth from "@/config/auth";

import { ChatRepository } from "@/modules/chat/repositories/chat-repository";
import { SupportTicketRepository } from "@/modules/chat/repositories/support-ticket-repository";
import { openOccurrenceTicket } from "@/modules/chat/usecases/shared/ticket-operations";
import { DeliveryRepository } from "@/modules/delivery/repositories/delivery-repository";
import { UserRepository } from "@/modules/user/repositories/user-repository";
import { DriverRepository } from "@/modules/driver/repositories/driver-repository";
import { RepairUnticketedMessagesUseCase } from "@/modules/chat/usecases/tickets/repair-unticketed-messages/repair-unticketed-messages-usecase";
import { renderChatMessagePush } from "@/shared/notifications/policies/chat-message-policy";
import type { ChatMessageSentPayload } from "@/shared/notifications/notification-types";

/**
 * Support tickets, round 2 of the review, over real HTTP and Postgres:
 *  - a delivery/route that changed drivers never hands the new driver the
 *    previous driver's ticket (report, legacy send, POST /chat/tickets);
 *  - the driver's double check sees a ticket read (per ticket, not thread);
 *  - the pushes carry the ticket the app opens;
 *  - the occurrence report opens its ticket on its own connection;
 *  - a deactivated company stops writing in tickets.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018ff100-0000-7000-8000-00000000000a";
const INACTIVE = "018ff100-0000-7000-8000-00000000000c";
const SHIPPER = "018ff100-0000-7000-8000-0000000000f1";
const DRIVER_A = "018ff100-0000-7000-8000-0000000000d1";
const DRIVER_B = "018ff100-0000-7000-8000-0000000000d2";
const DRIVER_NO_THREAD = "018ff100-0000-7000-8000-0000000000d3";
// Their own pair, so no tower message of another test sits in their 30-minute window.
const DRIVER_FORMER = "018ff100-0000-7000-8000-0000000000d4";
const DRIVER_HOLDER = "018ff100-0000-7000-8000-0000000000d5";
const TOWER_TYPE = "018ff100-0000-7000-8000-0000000000e1";
const PROBLEM_TYPE = "018ff100-0000-7000-8000-0000000000e2";

type Who = "admin" | "driverA" | "driverB" | "master" | "inactiveAdmin" | "former";

const users = {} as Record<Who, { id: string; token: string }>;

let cnpjSeq = 0;

async function seedBusiness(id: string, active = true): Promise<void> {
  cnpjSeq += 1;

  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${id.slice(-1)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua dos Repasses",
      address_number: "1",
      cnpj: String(53444555000180 + cnpjSeq),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${id}@exemplo.com.br`,
      is_active: active,
    },
  });

  await prisma.businessEntitlement.create({
    data: { businessId: id, module: "DELIVERIES", enabled: true },
  });
}

async function seedDriver(id: string, name: string): Promise<void> {
  await prisma.driver.create({
    data: {
      id,
      name,
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
      businessId: CARRIER,
    },
  });
}

async function seedUser(
  name: string,
  role: "BUSINESS_ADMIN" | "BUSINESS_USER" | "MASTER",
  businessId: string | null,
  driverId: string | null = null,
): Promise<{ id: string; token: string }> {
  const id = randomUUID();
  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id,
      name,
      email: `${id}@exemplo.com.br`,
      password: "not-used-here",
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
    token: sign({ tokenType: "access", sessionVersion: 0, familyId }, auth.secret_token, {
      subject: id,
      expiresIn: "15m",
    }),
  };
}

async function inTransit(recipient: string, driverId: string): Promise<string> {
  const delivery = await prisma.delivery.create({
    data: {
      recipient_name: recipient,
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Entregas",
      businessId: CARRIER,
      shipperId: SHIPPER,
      driverId,
      status: "IN_TRANSIT",
    },
  });

  return delivery.id;
}

/** What a reassignment (decision 14.7) leaves behind: the same delivery, another driver. */
async function reassign(deliveryId: string, driverId: string): Promise<void> {
  await prisma.delivery.update({ where: { id: deliveryId }, data: { driverId } });
}

interface Answer {
  status: number;
  body: Record<string, any>;
}

async function call(
  method: "GET" | "POST",
  url: string,
  token: string,
  payload?: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Answer> {
  const response = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}`, ...headers },
    ...(payload && { payload }),
  });

  return { status: response.statusCode, body: response.json() };
}

function openTicket(body: Record<string, unknown>, token: string) {
  return call("POST", "/chat/tickets", token, body, { "idempotency-key": randomUUID() });
}

function ticketMessage(ticketId: string, body: string, token: string) {
  return call("POST", `/chat/tickets/${ticketId}/messages`, token, {
    kind: "TEXT",
    body,
    clientSubmissionId: randomUUID(),
  });
}

async function threadOf(driverId: string): Promise<string> {
  return (
    await prisma.chatThread.findUniqueOrThrow({
      where: { businessId_driverId: { businessId: CARRIER, driverId } },
    })
  ).id;
}

beforeAll(async () => {
  await seedBusiness(CARRIER);
  await seedBusiness(INACTIVE, false);

  await prisma.shipper.create({ data: { id: SHIPPER, name: "Embarcador", businessId: CARRIER } });

  await seedDriver(DRIVER_A, "Antônio Anterior");
  await seedDriver(DRIVER_B, "Bruna Atual");
  await seedDriver(DRIVER_NO_THREAD, "Carla Sem Conversa");
  await seedDriver(DRIVER_FORMER, "Fábio Antigo");
  await seedDriver(DRIVER_HOLDER, "Helena Titular");

  users.admin = await seedUser("Ana Torre", "BUSINESS_ADMIN", CARRIER);
  users.driverA = await seedUser("Antônio Anterior", "BUSINESS_USER", CARRIER, DRIVER_A);
  users.driverB = await seedUser("Bruna Atual", "BUSINESS_USER", CARRIER, DRIVER_B);
  users.master = await seedUser("Mestre Suporte", "MASTER", null);
  users.inactiveAdmin = await seedUser("Ivo Inativo", "BUSINESS_ADMIN", INACTIVE);
  users.former = await seedUser("Fábio Antigo", "BUSINESS_USER", CARRIER, DRIVER_FORMER);

  await prisma.occurrenceType.createMany({
    data: [
      {
        id: TOWER_TYPE,
        name: "Cliente ausente",
        blocks_delivery: true,
        requires_authorization: true,
        businessId: CARRIER,
      },
      { id: PROBLEM_TYPE, name: "Avaria", blocks_delivery: false, businessId: CARRIER },
    ],
  });

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("a delivery or route that changed drivers", () => {
  it("gives the new driver his own ticket on POST /chat/tickets, and the system closes the previous one", async () => {
    const deliveryId = await inTransit("Mercado Repasse", DRIVER_A);

    const before = await openTicket({ deliveryId }, users.driverA.token);
    expect(before.status, JSON.stringify(before.body)).toBe(201);

    await reassign(deliveryId, DRIVER_B);

    const after = await openTicket({ deliveryId }, users.driverB.token);

    expect(after.status, JSON.stringify(after.body)).toBe(201);
    expect(after.body.created).toBe(true);
    expect(after.body.data.id).not.toBe(before.body.data.id);

    const mine = await prisma.supportTicket.findUniqueOrThrow({ where: { id: after.body.data.id } });
    expect(mine).toMatchObject({ driverId: DRIVER_B, threadId: await threadOf(DRIVER_B), status: "OPEN" });

    const previous = await prisma.supportTicket.findUniqueOrThrow({
      where: { id: before.body.data.id },
    });
    expect(previous).toMatchObject({
      driverId: DRIVER_A,
      status: "CLOSED",
      closedById: null,
      close_outcome: "RESOLVED",
    });
    expect(
      await prisma.supportTicketEvent.findFirst({
        where: { ticketId: previous.id, type: "CLOSED" },
      }),
    ).toMatchObject({ actor_kind: "SYSTEM", outcome: "RESOLVED" });

    // And the new driver can talk in it (it used to 404 on his own delivery).
    const sent = await ticketMessage(after.body.data.id, "Assumi esta entrega", users.driverB.token);
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
  });

  it("files the new driver's legacy message in a ticket of his, in his thread", async () => {
    const deliveryId = await inTransit("Padaria Repasse", DRIVER_A);

    const previous = await openTicket({ deliveryId }, users.driverA.token);
    expect(previous.status, JSON.stringify(previous.body)).toBe(201);

    await reassign(deliveryId, DRIVER_B);

    // The installed app that knows no tickets: delivery cited, no ticketId.
    const legacy = await call("POST", "/chat/send-message", users.driverB.token, {
      driverIds: [DRIVER_B],
      kind: "TEXT",
      body: "Estou com esta entrega agora",
      deliveryId,
      clientSubmissionId: randomUUID(),
    });

    expect(legacy.status, JSON.stringify(legacy.body)).toBe(201);

    const message = await prisma.chatMessage.findUniqueOrThrow({
      where: { id: legacy.body.data[0].id },
      include: { ticket: true },
    });

    expect(message.threadId).toBe(await threadOf(DRIVER_B));
    expect(message.ticket).toMatchObject({ driverId: DRIVER_B, deliveryId });
    expect(message.ticketId).not.toBe(previous.body.data.id);

    // The previous driver's ticket holds none of the new driver's words.
    expect(
      await prisma.chatMessage.count({
        where: { ticketId: previous.body.data.id, senderId: users.driverB.id },
      }),
    ).toBe(0);
  });

  it("does not link the previous driver's ticket to the new driver's occurrence", async () => {
    const deliveryId = await inTransit("Farmácia Repasse", DRIVER_A);

    const previous = await openTicket({ deliveryId }, users.driverA.token);
    expect(previous.status, JSON.stringify(previous.body)).toBe(201);

    await reassign(deliveryId, DRIVER_B);

    const report = await call(
      "POST",
      `/delivery/report-occurrence/${deliveryId}/business/${CARRIER}`,
      users.driverB.token,
      { occurrenceTypeId: PROBLEM_TYPE },
    );

    expect(report.status, JSON.stringify(report.body)).toBe(201);
    expect(report.body.data.ticket.id).not.toBe(previous.body.data.id);

    const opened = await prisma.supportTicket.findUniqueOrThrow({
      where: { id: report.body.data.ticket.id },
    });
    expect(opened).toMatchObject({
      kind: "OCCURRENCE",
      driverId: DRIVER_B,
      threadId: await threadOf(DRIVER_B),
      occurrenceId: report.body.data.id,
    });

    const untouched = await prisma.supportTicket.findUniqueOrThrow({
      where: { id: previous.body.data.id },
    });
    expect(untouched).toMatchObject({ kind: "DELIVERY", occurrenceId: null, driverId: DRIVER_A });

    // The tower's reply in the occurrence's ticket goes to the new driver.
    const reply = await ticketMessage(opened.id, "Pode deixar na portaria", users.admin.token);
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    expect(
      (await prisma.chatMessage.findUniqueOrThrow({ where: { id: reply.body.data.id } })).threadId,
    ).toBe(await threadOf(DRIVER_B));
  });

  it("gives the new driver of a route his own route ticket", async () => {
    const route = await prisma.route.create({
      data: {
        code: 701,
        name: "Repasse Leste",
        scheduled_date: new Date("2026-10-05T00:00:00Z"),
        status: "IN_PROGRESS",
        started_at: new Date(),
        businessId: CARRIER,
        driverId: DRIVER_A,
      },
    });

    const previous = await openTicket({ routeId: route.id }, users.driverA.token);
    expect(previous.status, JSON.stringify(previous.body)).toBe(201);

    await prisma.route.update({ where: { id: route.id }, data: { driverId: DRIVER_B } });

    const mine = await openTicket({ routeId: route.id }, users.driverB.token);

    expect(mine.status, JSON.stringify(mine.body)).toBe(201);
    expect(mine.body.data.id).not.toBe(previous.body.data.id);
    expect(
      await prisma.supportTicket.findUniqueOrThrow({ where: { id: mine.body.data.id } }),
    ).toMatchObject({ kind: "ROUTE", driverId: DRIVER_B, status: "OPEN" });
    expect(
      (await prisma.supportTicket.findUniqueOrThrow({ where: { id: previous.body.data.id } }))
        .status,
    ).toBe("CLOSED");
  });
});

describe("a caller whose driver no longer holds the delivery or route (review round 3)", () => {
  const repair = () =>
    new RepairUnticketedMessagesUseCase(
      new SupportTicketRepository(),
      new ChatRepository(),
      new DeliveryRepository(),
      new UserRepository(),
      new DriverRepository(),
    ).execute();

  /** The delivery moved from the former driver to the holder, who has a live ticket about it. */
  async function handedOverWithLiveTicket(recipient: string) {
    const deliveryId = await inTransit(recipient, DRIVER_FORMER);

    await reassign(deliveryId, DRIVER_HOLDER);

    const live = await openTicket({ driverId: DRIVER_HOLDER, deliveryId }, users.admin.token);
    expect(live.status, JSON.stringify(live.body)).toBe(201);

    return { deliveryId, liveId: live.body.data.id as string };
  }

  it("leaves the holder's ticket open when the repair files an old message of the former driver", async () => {
    const { deliveryId, liveId } = await handedOverWithLiveTicket("Stale Chip Repair");

    const thread = await prisma.chatThread.upsert({
      where: { businessId_driverId: { businessId: CARRIER, driverId: DRIVER_FORMER } },
      update: {},
      create: { businessId: CARRIER, driverId: DRIVER_FORMER },
    });

    const orphan = await prisma.chatMessage.create({
      data: {
        threadId: thread.id,
        senderId: users.former.id,
        kind: "TEXT",
        body: "Escrita pela imagem anterior, antes do repasse",
        deliveryId,
      },
    });

    await repair();

    expect(
      (await prisma.supportTicket.findUniqueOrThrow({ where: { id: liveId } })).status,
    ).toBe("OPEN");

    const filed = await prisma.chatMessage.findUniqueOrThrow({
      where: { id: orphan.id },
      include: { ticket: true },
    });

    expect(filed.ticket).toMatchObject({ driverId: DRIVER_FORMER, kind: "DRIVER" });
  });

  it("leaves the holder's route ticket open when the repair files an old route message of the former driver", async () => {
    const route = await prisma.route.create({
      data: {
        code: 702,
        name: "Repasse Oeste",
        scheduled_date: new Date("2026-10-05T00:00:00Z"),
        status: "IN_PROGRESS",
        started_at: new Date(),
        businessId: CARRIER,
        driverId: DRIVER_FORMER,
      },
    });

    await prisma.route.update({ where: { id: route.id }, data: { driverId: DRIVER_HOLDER } });

    const live = await openTicket({ driverId: DRIVER_HOLDER, routeId: route.id }, users.admin.token);
    expect(live.status, JSON.stringify(live.body)).toBe(201);

    const thread = await prisma.chatThread.upsert({
      where: { businessId_driverId: { businessId: CARRIER, driverId: DRIVER_FORMER } },
      update: {},
      create: { businessId: CARRIER, driverId: DRIVER_FORMER },
    });

    const orphan = await prisma.chatMessage.create({
      data: {
        threadId: thread.id,
        senderId: users.former.id,
        kind: "TEXT",
        body: "Mensagem de rota da imagem anterior",
        routeId: route.id,
      },
    });

    await repair();

    expect(
      (await prisma.supportTicket.findUniqueOrThrow({ where: { id: live.body.data.id } })).status,
    ).toBe("OPEN");

    const filed = await prisma.chatMessage.findUniqueOrThrow({
      where: { id: orphan.id },
      include: { ticket: true },
    });

    expect(filed.ticket).toMatchObject({ driverId: DRIVER_FORMER, kind: "DRIVER" });
  });

  // After the repair cases: this one leaves a tower message in the former
  // driver's 30-minute window.
  it("leaves the holder's ticket open when the tower cites the delivery in the former driver's conversation", async () => {
    const { deliveryId, liveId } = await handedOverWithLiveTicket("Stale Chip Panel");

    // The panel as it is today: an unfiltered conversation sends deliveryId, no ticketId.
    const sent = await call("POST", "/chat/send-message", users.admin.token, {
      driverIds: [DRIVER_FORMER],
      kind: "TEXT",
      body: "Sobre aquela entrega",
      deliveryId,
      clientSubmissionId: randomUUID(),
    });

    expect(sent.status, JSON.stringify(sent.body)).toBe(201);

    expect(
      await prisma.supportTicket.findUniqueOrThrow({ where: { id: liveId } }),
    ).toMatchObject({ status: "OPEN", driverId: DRIVER_HOLDER });
    expect(
      await prisma.supportTicketEvent.count({ where: { ticketId: liveId, type: "CLOSED" } }),
    ).toBe(0);

    // The message stays with the former driver, in a general ticket of his.
    const message = await prisma.chatMessage.findUniqueOrThrow({
      where: { id: sent.body.data[0].id },
      include: { ticket: true },
    });

    expect(message.threadId).toBe(await threadOf(DRIVER_FORMER));
    expect(message.ticket).toMatchObject({ driverId: DRIVER_FORMER, kind: "DRIVER" });
    expect(
      await prisma.supportTicket.count({
        where: { deliveryId, driverId: DRIVER_FORMER, kind: "DELIVERY" },
      }),
    ).toBe(0);
  });

  it("still hands the ticket over when the holder himself writes about it", async () => {
    const deliveryId = await inTransit("Repasse Provado", DRIVER_FORMER);

    const former = await openTicket({ driverId: DRIVER_FORMER, deliveryId }, users.admin.token);
    expect(former.status, JSON.stringify(former.body)).toBe(201);

    await reassign(deliveryId, DRIVER_HOLDER);

    // The tower writing to the holder about his delivery is a proven handover.
    const sent = await call("POST", "/chat/send-message", users.admin.token, {
      driverIds: [DRIVER_HOLDER],
      kind: "TEXT",
      body: "A entrega agora é sua",
      deliveryId,
      clientSubmissionId: randomUUID(),
    });

    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    expect(
      (await prisma.supportTicket.findUniqueOrThrow({ where: { id: former.body.data.id } })).status,
    ).toBe("CLOSED");

    const message = await prisma.chatMessage.findUniqueOrThrow({
      where: { id: sent.body.data[0].id },
      include: { ticket: true },
    });
    expect(message.ticket).toMatchObject({ driverId: DRIVER_HOLDER, kind: "DELIVERY", deliveryId });
  });
});

describe("the driver's double check reads the ticket cursors", () => {
  it("shows the tower's read of one ticket on that ticket's messages only, before and after a reload", async () => {
    const first = await openTicket(
      { deliveryId: await inTransit("Leitura Um", DRIVER_A) },
      users.driverA.token,
    );
    const second = await openTicket(
      { deliveryId: await inTransit("Leitura Dois", DRIVER_A) },
      users.driverA.token,
    );

    const inFirst = await ticketMessage(first.body.data.id, "Sobre a primeira", users.driverA.token);
    const inSecond = await ticketMessage(second.body.data.id, "Sobre a segunda", users.driverA.token);

    expect(inFirst.status, JSON.stringify(inFirst.body)).toBe(201);
    expect(inSecond.status, JSON.stringify(inSecond.body)).toBe(201);

    // The tower opens ticket #1 only.
    const read = await call("POST", `/chat/tickets/${first.body.data.id}/read`, users.admin.token, {
      readAt: new Date().toISOString(),
    });
    expect(read.status, JSON.stringify(read.body)).toBe(200);

    // The driver's feed (the reload): the thread cursor did not move, the
    // ticket cursor covers #1's message and nothing covers #2's.
    const feed = await call("GET", "/chat/list-messages?limit=50", users.driverA.token);

    expect(feed.status, JSON.stringify(feed.body)).toBe(200);
    expect(feed.body.counterpartLastReadAt).toBeNull();

    const cursors = feed.body.counterpartTicketReadAt as Record<string, string>;
    expect(Object.keys(cursors)).toEqual([first.body.data.id]);
    expect(new Date(cursors[first.body.data.id]).getTime()).toBeGreaterThanOrEqual(
      new Date(inFirst.body.data.created_at).getTime(),
    );

    // A view filtered to the ticket answers that ticket's cursor directly.
    const firstView = await call(
      "GET",
      `/chat/tickets/${first.body.data.id}/messages?limit=50`,
      users.driverA.token,
    );
    const secondView = await call(
      "GET",
      `/chat/tickets/${second.body.data.id}/messages?limit=50`,
      users.driverA.token,
    );

    expect(new Date(firstView.body.counterpartLastReadAt).getTime()).toBeGreaterThanOrEqual(
      new Date(inFirst.body.data.created_at).getTime(),
    );
    expect(secondView.body.counterpartLastReadAt).toBeNull();

    // The driver's own reads never count as the tower's.
    await call("POST", `/chat/tickets/${second.body.data.id}/read`, users.driverA.token, {});

    const again = await call("GET", "/chat/list-messages?limit=50", users.driverA.token);
    expect(Object.keys(again.body.counterpartTicketReadAt)).toEqual([first.body.data.id]);
  });
});

describe("the pushes carry the ticket", () => {
  it("puts the ticket in the chat push data the app opens", async () => {
    const opened = await openTicket(
      { deliveryId: await inTransit("Push Conversa", DRIVER_A) },
      users.driverA.token,
    );

    const reply = await ticketMessage(opened.body.data.id, "Estou vendo aqui", users.admin.token);
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);

    const row = await prisma.domainOutboxEvent.findFirstOrThrow({
      where: { topic: "chat-message.sent", payload: { path: ["messageId"], equals: reply.body.data.id } },
    });

    const payload = row.payload as unknown as ChatMessageSentPayload;

    expect(payload).toMatchObject({
      ticketId: opened.body.data.id,
      ticketNumber: opened.body.data.number,
      ticketSubject: opened.body.data.subject,
    });
    expect(renderChatMessagePush(payload).data).toEqual({
      url: "/chat",
      ticketId: opened.body.data.id,
      ticketNumber: opened.body.data.number,
      ticketSubject: opened.body.data.subject,
    });
  });

  it("puts the closed ticket in the authorization decision sent to the driver", async () => {
    const deliveryId = await inTransit("Push Decisão", DRIVER_A);
    const report = await call(
      "POST",
      `/delivery/report-occurrence/${deliveryId}/business/${CARRIER}`,
      users.driverA.token,
      { occurrenceTypeId: TOWER_TYPE },
    );

    expect(report.status, JSON.stringify(report.body)).toBe(201);

    const ticketId = report.body.data.ticket.id as string;
    const closed = await call("POST", `/chat/tickets/${ticketId}/close`, users.admin.token, {
      outcome: "APPROVED",
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);

    const row = await prisma.domainOutboxEvent.findFirstOrThrow({
      where: {
        topic: "delivery-occurrence.authorization_decided",
        eventKey: `delivery-occurrence.authorization_decided:${report.body.data.id}`,
      },
    });

    expect((row.payload as Record<string, unknown>).ticketId).toBe(ticketId);
  });
});

describe("the report opens its ticket on its own connection", () => {
  it("creates the driver's thread inside the transaction, even with a pool of one connection", async () => {
    const url = new URL(process.env.DATABASE_URL!);
    url.searchParams.set("connection_limit", "1");
    url.searchParams.set("pool_timeout", "3");

    const narrow = new PrismaClient({ datasources: { db: { url: url.toString() } } });

    try {
      const deliveryId = await inTransit("Uma Conexão", DRIVER_NO_THREAD);
      const occurrence = await prisma.deliveryOccurrence.create({
        data: {
          deliveryId,
          businessId: CARRIER,
          occurrenceTypeId: PROBLEM_TYPE,
          reportedById: users.admin.id,
          photos: [],
        },
      });

      // The whole transaction holds the only connection. A thread lookup on
      // a second connection would wait for it and time out (P2024).
      const { ticket } = await narrow.$transaction(
        (tx) =>
          openOccurrenceTicket(
            { tickets: new SupportTicketRepository(narrow), chat: new ChatRepository(narrow) },
            {
              businessId: CARRIER,
              deliveryId,
              driverId: DRIVER_NO_THREAD,
              occurrenceId: occurrence.id,
              occurrenceTypeName: "Avaria",
              recipientName: "Uma Conexão",
              actor: { kind: "USER", id: users.admin.id, name: "Ana Torre" },
            },
            tx,
          ),
        { timeout: 15_000 },
      );

      expect(ticket).toMatchObject({ kind: "OCCURRENCE", driverId: DRIVER_NO_THREAD });
      expect(ticket.threadId).toBe(await threadOf(DRIVER_NO_THREAD));
    } finally {
      await narrow.$disconnect();
    }
  }, 30_000);

  it("leaves no thread behind when the report rolls back", async () => {
    const driverId = randomUUID();
    await seedDriver(driverId, "Daniel Desfeito");

    const deliveryId = await inTransit("Desfeita", driverId);
    const occurrence = await prisma.deliveryOccurrence.create({
      data: {
        deliveryId,
        businessId: CARRIER,
        occurrenceTypeId: PROBLEM_TYPE,
        reportedById: users.admin.id,
        photos: [],
      },
    });

    await expect(
      prisma.$transaction(async (tx) => {
        await openOccurrenceTicket(
          { tickets: new SupportTicketRepository(), chat: new ChatRepository() },
          {
            businessId: CARRIER,
            deliveryId,
            driverId,
            occurrenceId: occurrence.id,
            occurrenceTypeName: "Avaria",
            recipientName: "Desfeita",
            actor: { kind: "USER", id: users.admin.id, name: "Ana Torre" },
          },
          tx,
        );

        throw new Error("report failed after the ticket");
      }),
    ).rejects.toThrow("report failed after the ticket");

    expect(await prisma.chatThread.count({ where: { driverId } })).toBe(0);
    expect(await prisma.supportTicket.count({ where: { deliveryId } })).toBe(0);
  });
});

describe("a deactivated company", () => {
  it("cannot write in a ticket (TENANT_INACTIVE for the MASTER naming it, refused session for its own staff)", async () => {
    const ticketId = randomUUID();

    const asMaster = await call(
      "POST",
      `/chat/tickets/${ticketId}/messages?businessId=${INACTIVE}`,
      users.master.token,
      { kind: "TEXT", body: "Olá", clientSubmissionId: randomUUID() },
    );

    expect(asMaster.status, JSON.stringify(asMaster.body)).toBe(403);
    expect(asMaster.body.code).toBe("TENANT_INACTIVE");

    const asOwnStaff = await ticketMessage(ticketId, "Olá", users.inactiveAdmin.token);

    expect(asOwnStaff.status, JSON.stringify(asOwnStaff.body)).toBe(403);
  });
});

describe("the repair window reads this database's backfill (review round 3)", () => {
  it("answers the backfill migration's finished_at from _prisma_migrations", async () => {
    const repository = new SupportTicketRepository();
    // A real record (a migrated database) answers before and after the test row.
    const real = await repository.ticketsBackfilledAt();
    const id = randomUUID();
    // In the past, so the repair jobs of files running in parallel only see a
    // wider window, never a narrower one.
    const finishedAt = new Date("2020-01-01T00:00:00.000Z");

    await prisma.$executeRaw`
      INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, started_at, applied_steps_count)
      VALUES (${id}, 'test-only', ${finishedAt}, '20261005120600_support_tickets_backfill', ${finishedAt}, 1)
    `;

    try {
      expect(await repository.ticketsBackfilledAt()).toEqual(real ?? finishedAt);

      // A rolled-back attempt is not a backfill.
      await prisma.$executeRaw`UPDATE _prisma_migrations SET rolled_back_at = now() WHERE id = ${id}`;
      expect(await repository.ticketsBackfilledAt()).toEqual(real);
    } finally {
      await prisma.$executeRaw`DELETE FROM _prisma_migrations WHERE id = ${id}`;
    }
  });
});
