import "@/shared";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { sign } from "jsonwebtoken";

import { randomUUID } from "node:crypto";

import auth from "@/config/auth";

/**
 * Support tickets (decision 14.5) over real HTTP and Postgres: the report
 * opens the occurrence's ticket in its transaction, closing it IS the tower's
 * decision (and the queue's decision closes it), the trail names who handled
 * and who closed, messages land in the ticket, and the walls — another
 * company, another driver, a read-only profile, the MASTER.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018feb00-0000-7000-8000-00000000000a";
const OTHER = "018feb00-0000-7000-8000-00000000000b";

const SHIPPER = "018feb00-0000-7000-8000-0000000000f1";
const DRIVER = "018feb00-0000-7000-8000-0000000000d1";
const OTHER_DRIVER = "018feb00-0000-7000-8000-0000000000d2";
const FOREIGN_DRIVER = "018feb00-0000-7000-8000-0000000000d3";

const TOWER_TYPE = "018feb00-0000-7000-8000-0000000000e1";
const PROBLEM_TYPE = "018feb00-0000-7000-8000-0000000000e2";

type Who =
  | "admin"
  | "operator"
  | "readOnly"
  | "driver"
  | "otherDriver"
  | "otherAdmin"
  | "master";

const users = {} as Record<Who, { id: string; token: string }>;

let cnpjSeq = 0;

async function seedBusiness(id: string): Promise<void> {
  cnpjSeq += 1;

  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${id.slice(-1)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua dos Atendimentos",
      address_number: "1",
      cnpj: String(51222555000180 + cnpjSeq),
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

async function seedDriver(
  id: string,
  name: string,
  businessId: string,
): Promise<void> {
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
      businessId,
    },
  });
}

async function seedProfile(
  businessId: string,
  write: boolean,
): Promise<string> {
  const profile = await prisma.profileAccess.create({
    data: {
      name: `Perfil ${randomUUID().slice(0, 8)}`,
      businessId,
      permissions: {
        create: [
          {
            permissionKey: "delivery_manage",
            action: "delivery_manage",
            canRead: true,
            canWrite: write,
            businessId,
          },
          {
            permissionKey: "occurrence_manage",
            action: "occurrence_manage",
            canRead: true,
            canWrite: write,
            businessId,
          },
        ],
      },
    },
  });

  return profile.id;
}

async function seedUser(
  name: string,
  role: "BUSINESS_ADMIN" | "BUSINESS_USER" | "MASTER",
  businessId: string | null,
  extra: { profileAccessId?: string; driverId?: string } = {},
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
      profileAccessId: extra.profileAccessId ?? null,
      driverId: extra.driverId ?? null,
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
  driverId = DRIVER,
): Promise<string> {
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

interface Answer {
  status: number;
  body: Record<string, any>;
}

async function call(
  method: "GET" | "POST" | "PUT",
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

function report(
  deliveryId: string,
  typeId: string,
  token = users.driver.token,
  extra = {},
) {
  return call(
    "POST",
    `/delivery/report-occurrence/${deliveryId}/business/${CARRIER}`,
    token,
    {
      occurrenceTypeId: typeId,
      ...extra,
    },
  );
}

function closeTicket(
  ticketId: string,
  body: Record<string, unknown>,
  token: string,
  query = "",
) {
  return call("POST", `/chat/tickets/${ticketId}/close${query}`, token, body);
}

function openTicket(
  body: Record<string, unknown>,
  token: string,
  key: string | null = randomUUID(),
) {
  return call(
    "POST",
    "/chat/tickets",
    token,
    body,
    key ? { "idempotency-key": key } : {},
  );
}

async function pendingTicket(recipient: string) {
  const deliveryId = await inTransit(recipient);
  const answer = await report(deliveryId, TOWER_TYPE);

  expect(answer.status, JSON.stringify(answer.body)).toBe(201);
  expect(answer.body.data.authorization_status).toBe("PENDING");
  expect(answer.body.data.ticket).toEqual({
    id: expect.any(String),
    number: expect.any(Number),
  });

  return {
    deliveryId,
    occurrenceId: answer.body.data.id as string,
    ticketId: answer.body.data.ticket.id as string,
  };
}

beforeAll(async () => {
  await seedBusiness(CARRIER);
  await seedBusiness(OTHER);

  await prisma.shipper.create({
    data: { id: SHIPPER, name: "Embarcador", businessId: CARRIER },
  });

  await seedDriver(DRIVER, "João Motorista", CARRIER);
  await seedDriver(OTHER_DRIVER, "Beatriz Motorista", CARRIER);
  await seedDriver(FOREIGN_DRIVER, "Estranho", OTHER);

  users.admin = await seedUser("Ana Administradora", "BUSINESS_ADMIN", CARRIER);
  users.operator = await seedUser("Otto Torre", "BUSINESS_USER", CARRIER, {
    profileAccessId: await seedProfile(CARRIER, true),
  });
  users.readOnly = await seedUser("Rita Leitura", "BUSINESS_USER", CARRIER, {
    profileAccessId: await seedProfile(CARRIER, false),
  });
  users.driver = await seedUser("João Motorista", "BUSINESS_USER", CARRIER, {
    driverId: DRIVER,
  });
  users.otherDriver = await seedUser(
    "Beatriz Motorista",
    "BUSINESS_USER",
    CARRIER,
    {
      driverId: OTHER_DRIVER,
    },
  );
  users.otherAdmin = await seedUser("Beto Outra", "BUSINESS_ADMIN", OTHER);
  users.master = await seedUser("Mestre Suporte", "MASTER", null);

  await prisma.occurrenceType.createMany({
    data: [
      {
        id: TOWER_TYPE,
        name: "Cliente ausente",
        blocks_delivery: true,
        requires_authorization: true,
        businessId: CARRIER,
      },
      {
        id: PROBLEM_TYPE,
        name: "Avaria",
        blocks_delivery: false,
        businessId: CARRIER,
      },
    ],
  });

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("the report opens the occurrence's ticket", () => {
  it("opens one ticket for a request waiting for the tower, and a resend names the same ticket", async () => {
    const deliveryId = await inTransit("Mercado Sol");
    const key = randomUUID();

    const first = await report(deliveryId, TOWER_TYPE, users.driver.token, {
      client_submission_id: key,
    });
    const resend = await report(deliveryId, TOWER_TYPE, users.driver.token, {
      client_submission_id: key,
    });

    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(resend.body.data).toMatchObject({
      replayed: true,
      ticket: first.body.data.ticket,
    });

    const tickets = await prisma.supportTicket.findMany({
      where: { deliveryId },
    });

    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({
      kind: "OCCURRENCE",
      status: "OPEN",
      occurrenceId: first.body.data.id,
      subject: "Cliente ausente — Mercado Sol",
      opened_via: "OCCURRENCE_REPORT",
      openedById: users.driver.id,
      driverId: DRIVER,
    });

    const detail = await call(
      "GET",
      `/chat/tickets/${tickets[0].id}`,
      users.operator.token,
    );

    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect(detail.body.data).toMatchObject({
      kind: "OCCURRENCE",
      closeOutcomes: ["APPROVED", "DENIED"],
      occurrence: {
        authorization_status: "PENDING",
        typeName: "Cliente ausente",
      },
      occurrenceDetail: { reportedBy: { name: "João Motorista" } },
      permissions: {
        canClose: true,
        canDecide: true,
        closeOutcomes: ["APPROVED", "DENIED"],
      },
    });
    expect(detail.body.data.occurrence.escalates_at).toEqual(
      expect.any(String),
    );
  });

  it("opens a ticket for a driver's problem report, and none for a panel report that applied at once", async () => {
    const byDriver = await inTransit("Padaria Lua");
    const byPanel = await inTransit("Farmácia Sol");

    const driverReport = await report(byDriver, PROBLEM_TYPE);
    const panelReport = await report(
      byPanel,
      PROBLEM_TYPE,
      users.operator.token,
      {
        description: "Registrado pela torre",
      },
    );

    expect(driverReport.body.data.ticket).toEqual(
      expect.objectContaining({ id: expect.any(String) }),
    );
    expect(panelReport.status, JSON.stringify(panelReport.body)).toBe(201);
    expect(panelReport.body.data.ticket).toBeNull();
    expect(
      await prisma.supportTicket.count({ where: { deliveryId: byPanel } }),
    ).toBe(0);
  });

  it("turns the open DELIVERY ticket of the same delivery into the occurrence's ticket", async () => {
    const deliveryId = await inTransit("Loja Azul");

    const opened = await openTicket({ deliveryId }, users.driver.token);

    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    expect(opened.body.data.kind).toBe("DELIVERY");

    const answer = await report(deliveryId, TOWER_TYPE);

    expect(answer.body.data.ticket.id).toBe(opened.body.data.id);

    const ticket = await prisma.supportTicket.findUniqueOrThrow({
      where: { id: opened.body.data.id },
    });

    expect(ticket).toMatchObject({
      kind: "OCCURRENCE",
      occurrenceId: answer.body.data.id,
    });

    const events = await prisma.supportTicketEvent.findMany({
      where: { ticketId: ticket.id },
      orderBy: { created_at: "asc" },
    });

    expect(events.map((event) => event.type)).toEqual([
      "OPENED",
      "OCCURRENCE_LINKED",
    ]);
  });
});

describe("closing the ticket of a request IS the decision", () => {
  it("refuses RESOLVED while the authorization waits, and APPROVED applies the decision and closes the ticket together", async () => {
    const { deliveryId, occurrenceId, ticketId } =
      await pendingTicket("Cliente Aprova");

    const resolved = await closeTicket(
      ticketId,
      { outcome: "RESOLVED" },
      users.operator.token,
    );

    expect(resolved.status).toBe(409);
    expect(resolved.body.code).toBe("SUPPORT_TICKET_AUTHORIZATION_PENDING");

    const approved = await closeTicket(
      ticketId,
      { outcome: "APPROVED" },
      users.operator.token,
    );

    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body).toMatchObject({
      message: "Ocorrência autorizada. O motorista já foi avisado.",
      replayed: false,
      data: {
        status: "CLOSED",
        close_outcome: "APPROVED",
        closedBy: { id: users.operator.id, name: "Otto Torre" },
        // Nobody had taken it: whoever closes is who handled it.
        assignee: { id: users.operator.id, name: "Otto Torre" },
        closeOutcomes: [],
      },
      decision: { authorization_status: "APPROVED" },
    });

    const occurrence = await prisma.deliveryOccurrence.findUniqueOrThrow({
      where: { id: occurrenceId },
    });
    const delivery = await prisma.delivery.findUniqueOrThrow({
      where: { id: deliveryId },
    });

    expect(occurrence.authorization_status).toBe("APPROVED");
    expect(delivery.status).toBe("FAILED");

    const events = await call(
      "GET",
      `/chat/tickets/${ticketId}/events`,
      users.admin.token,
    );

    expect(
      events.body.data.map((event: { type: string }) => event.type),
    ).toEqual(["OPENED", "ASSIGNED", "AUTHORIZATION_DECIDED", "CLOSED"]);
    expect(events.body.data[3]).toMatchObject({
      actor_name: "Otto Torre",
      outcome: "APPROVED",
    });

    // The same person repeating it is a replay; someone else is told who.
    const again = await closeTicket(
      ticketId,
      { outcome: "APPROVED" },
      users.operator.token,
    );
    const other = await closeTicket(
      ticketId,
      { outcome: "DENIED", note: "Não" },
      users.admin.token,
    );

    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect(other.status).toBe(409);
    expect(other.body).toMatchObject({
      code: "SUPPORT_TICKET_ALREADY_CLOSED",
      closedBy: { id: users.operator.id, name: "Otto Torre" },
      outcome: "APPROVED",
    });
  });

  it("asks for a note to deny, like the queue does", async () => {
    const { ticketId } = await pendingTicket("Cliente Nega");

    const denied = await closeTicket(
      ticketId,
      { outcome: "DENIED" },
      users.operator.token,
    );

    expect(denied.status).toBe(400);
    expect(denied.body.code).toBe("AUTHORIZATION_NOTE_REQUIRED");
    expect(
      (
        await prisma.supportTicket.findUniqueOrThrow({
          where: { id: ticketId },
        })
      ).status,
    ).toBe("OPEN");
  });

  it("closes the ticket when the tower decides from the queue", async () => {
    const { occurrenceId, ticketId } = await pendingTicket("Cliente Fila");

    const decided = await call(
      "POST",
      `/delivery/occurrence-authorization/${occurrenceId}/business/${CARRIER}`,
      users.admin.token,
      { decision: "DENIED", note: "Volte amanhã" },
    );

    expect(decided.status, JSON.stringify(decided.body)).toBe(200);

    const ticket = await prisma.supportTicket.findUniqueOrThrow({
      where: { id: ticketId },
    });

    expect(ticket).toMatchObject({
      status: "CLOSED",
      close_outcome: "DENIED",
      close_note: "Volte amanhã",
      closedById: users.admin.id,
      assigneeId: users.admin.id,
    });
  });

  it("refuses APPROVED on a ticket with no authorization, and closes it RESOLVED with who handled it", async () => {
    const deliveryId = await inTransit("Cliente Geral");
    const opened = await openTicket({ deliveryId }, users.driver.token);

    const approved = await closeTicket(
      opened.body.data.id,
      { outcome: "APPROVED" },
      users.admin.token,
    );

    expect(approved.status).toBe(409);
    expect(approved.body.code).toBe("SUPPORT_TICKET_NOT_AUTHORIZATION");

    const resolved = await closeTicket(
      opened.body.data.id,
      { outcome: "RESOLVED", note: "Endereço confirmado" },
      users.admin.token,
    );

    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    expect(resolved.body).toMatchObject({
      message: "Atendimento encerrado.",
      data: {
        status: "CLOSED",
        close_outcome: "RESOLVED",
        close_note: "Endereço confirmado",
        closedBy: { id: users.admin.id },
        assignee: { id: users.admin.id },
      },
    });
  });
});

describe("messages in a ticket", () => {
  it("lands the driver's message in the ticket, and the tower's first reply takes the ticket", async () => {
    const { ticketId } = await pendingTicket("Cliente Conversa");

    const fromDriver = await call(
      "POST",
      `/chat/tickets/${ticketId}/messages`,
      users.driver.token,
      {
        kind: "TEXT",
        body: "Cliente não atende",
        clientSubmissionId: randomUUID(),
      },
    );

    expect(fromDriver.status, JSON.stringify(fromDriver.body)).toBe(201);
    expect(fromDriver.body.data).toMatchObject({
      ticketId,
      ticket: { id: ticketId, status: "OPEN" },
    });

    // The tower sees it unread.
    const summary = await call(
      "GET",
      "/chat/tickets/summary",
      users.operator.token,
    );

    expect(summary.status).toBe(200);
    expect(summary.body.unreadOpen).toBeGreaterThanOrEqual(1);

    const reply = await call(
      "POST",
      `/chat/tickets/${ticketId}/messages`,
      users.operator.token,
      {
        kind: "TEXT",
        body: "Aguarde dez minutos",
      },
    );

    expect(reply.status, JSON.stringify(reply.body)).toBe(201);

    const ticket = await prisma.supportTicket.findUniqueOrThrow({
      where: { id: ticketId },
    });

    expect(ticket.assigneeId).toBe(users.operator.id);
    expect(ticket.first_staff_reply_at).not.toBeNull();
    expect(ticket.last_driver_message_at).not.toBeNull();

    const page = await call(
      "GET",
      `/chat/tickets/${ticketId}/messages`,
      users.operator.token,
    );

    expect(page.status).toBe(200);
    expect(
      page.body.data.map((message: { body: string }) => message.body),
    ).toEqual(["Aguarde dez minutos", "Cliente não atende"]);
    expect(page.body.tickets).toEqual([
      expect.objectContaining({ id: ticketId }),
    ]);

    // Reading the ticket clears it for this reader.
    const read = await call(
      "POST",
      `/chat/tickets/${ticketId}/read`,
      users.operator.token,
      {},
    );

    expect(read.status).toBe(200);

    const list = await call(
      "GET",
      `/chat/tickets?deliveryId=${ticket.deliveryId}&status=ALL`,
      users.operator.token,
    );

    expect(list.body.data[0]).toMatchObject({ id: ticketId, unreadCount: 0 });
  });

  it("refuses a message in a closed ticket with its number and date", async () => {
    const deliveryId = await inTransit("Cliente Fechado");
    const opened = await openTicket({ deliveryId }, users.driver.token);

    await closeTicket(
      opened.body.data.id,
      { outcome: "RESOLVED" },
      users.admin.token,
    );

    const late = await call(
      "POST",
      `/chat/tickets/${opened.body.data.id}/messages`,
      users.driver.token,
      {
        kind: "TEXT",
        body: "Ainda está aí?",
      },
    );

    expect(late.status).toBe(409);
    expect(late.body).toMatchObject({
      code: "SUPPORT_TICKET_CLOSED",
      ticketId: opened.body.data.id,
      number: opened.body.data.number,
      closed_at: expect.any(String),
    });
    expect(
      await prisma.chatMessage.count({ where: { body: "Ainda está aí?" } }),
    ).toBe(0);
  });

  it("files a message from a client that does not know tickets (legacy routing) in the delivery's ticket", async () => {
    const deliveryId = await inTransit("Cliente Legado");

    const legacy = await call(
      "POST",
      "/chat/send-message",
      users.driver.token,
      {
        driverIds: [DRIVER],
        kind: "TEXT",
        body: "Mensagem do app antigo",
        deliveryId,
        clientSubmissionId: randomUUID(),
      },
    );

    expect(legacy.status, JSON.stringify(legacy.body)).toBe(201);

    const stored = await prisma.chatMessage.findFirstOrThrow({
      where: { body: "Mensagem do app antigo" },
    });
    const ticket = await prisma.supportTicket.findUniqueOrThrow({
      where: { id: stored.ticketId! },
    });

    expect(ticket).toMatchObject({
      kind: "DELIVERY",
      deliveryId,
      opened_via: "LEGACY_ROUTING",
    });
    expect(legacy.body.data[0].ticket).toMatchObject({ id: ticket.id });
  });

  it("keeps a mass notice out of every ticket", async () => {
    const notice = await call(
      "POST",
      "/chat/send-message",
      users.admin.token,
      {
        driverIds: [DRIVER, OTHER_DRIVER],
        kind: "TEXT",
        body: "Aviso geral da base",
      },
      { "idempotency-key": randomUUID() },
    );

    expect(notice.status, JSON.stringify(notice.body)).toBe(201);

    const rows = await prisma.chatMessage.findMany({
      where: { body: "Aviso geral da base" },
    });

    expect(rows).toHaveLength(2);
    expect(
      rows.every((row) => row.ticketId === null && row.broadcast_id !== null),
    ).toBe(true);
  });
});

describe("assignment", () => {
  it("takes, refuses a stale transfer, and refuses an operator of another company", async () => {
    const deliveryId = await inTransit("Cliente Atribuição");
    const opened = await openTicket({ deliveryId }, users.driver.token);
    const ticketId = opened.body.data.id;

    const take = await call(
      "POST",
      `/chat/tickets/${ticketId}/assign`,
      users.operator.token,
      {
        assigneeId: users.operator.id,
        expectedAssigneeId: null,
      },
    );

    expect(take.status, JSON.stringify(take.body)).toBe(200);
    expect(take.body.data.assignee).toEqual({
      id: users.operator.id,
      name: "Otto Torre",
    });

    // The admin's screen still showed "Sem atendente".
    const stale = await call(
      "POST",
      `/chat/tickets/${ticketId}/assign`,
      users.admin.token,
      {
        assigneeId: users.admin.id,
        expectedAssigneeId: null,
      },
    );

    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({
      code: "SUPPORT_TICKET_ASSIGNEE_CHANGED",
      assignee: { id: users.operator.id, name: "Otto Torre" },
    });

    const foreign = await call(
      "POST",
      `/chat/tickets/${ticketId}/assign`,
      users.admin.token,
      {
        assigneeId: users.otherAdmin.id,
      },
    );

    expect(foreign.status).toBe(404);
    expect(foreign.body.code).toBe("SUPPORT_TICKET_ASSIGNEE_NOT_FOUND");

    const driverAsAssignee = await call(
      "POST",
      `/chat/tickets/${ticketId}/assign`,
      users.admin.token,
      {
        assigneeId: users.driver.id,
      },
    );

    expect(driverAsAssignee.status).toBe(404);

    const assignees = await call(
      "GET",
      "/chat/tickets/assignees",
      users.operator.token,
    );

    expect(
      assignees.body.data.map((person: { name: string }) => person.name),
    ).toEqual(["Ana Administradora", "Otto Torre"]);
  });
});

describe("opening and reopening", () => {
  it("requires the Idempotency-Key, answers the same ticket to the same key, and one open ticket per delivery", async () => {
    const deliveryId = await inTransit("Cliente Abertura");

    const missing = await openTicket({ deliveryId }, users.driver.token, null);

    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe("IDEMPOTENCY_KEY_REQUIRED");

    const key = randomUUID();
    const first = await openTicket({ deliveryId }, users.driver.token, key);
    const retry = await openTicket({ deliveryId }, users.driver.token, key);
    const fromTower = await openTicket(
      { driverId: DRIVER, deliveryId },
      users.admin.token,
    );

    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({
      created: false,
      data: { id: first.body.data.id },
    });
    expect(fromTower.body).toMatchObject({
      created: false,
      data: { id: first.body.data.id },
    });

    const both = await openTicket(
      { deliveryId, routeId: randomUUID() },
      users.driver.token,
    );

    expect(both.status).toBe(400);
    expect(both.body.code).toBe("SUPPORT_TICKET_CONTEXT_CONFLICT");
  });

  it("asks the tower for a subject on a general ticket and sends the first message with it", async () => {
    const noSubject = await openTicket({ driverId: DRIVER }, users.admin.token);

    expect(noSubject.status).toBe(400);
    expect(noSubject.body.code).toBe("SUPPORT_TICKET_SUBJECT_REQUIRED");

    const opened = await openTicket(
      {
        driverId: DRIVER,
        subject: "Documentos do veículo",
        message: { kind: "TEXT", body: "Traga o CRLV amanhã" },
      },
      users.admin.token,
    );

    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    expect(opened.body.data).toMatchObject({
      kind: "DRIVER",
      subject: "Documentos do veículo",
    });
    expect(opened.body.message).toMatchObject({
      body: "Traga o CRLV amanhã",
      ticketId: opened.body.data.id,
    });

    const reopenOpen = await call(
      "POST",
      `/chat/tickets/${opened.body.data.id}/reopen`,
      users.admin.token,
      {},
    );

    expect(reopenOpen.body.replayed).toBe(true);

    await closeTicket(
      opened.body.data.id,
      { outcome: "RESOLVED" },
      users.admin.token,
    );

    const reopened = await call(
      "POST",
      `/chat/tickets/${opened.body.data.id}/reopen`,
      users.admin.token,
      {
        note: "Faltou o seguro",
      },
    );

    expect(reopened.status).toBe(200);
    expect(reopened.body.data).toMatchObject({
      status: "OPEN",
      closedBy: null,
      close_outcome: null,
    });
    expect(
      (
        await prisma.supportTicket.findUniqueOrThrow({
          where: { id: opened.body.data.id },
        })
      ).reopened_count,
    ).toBe(1);
  });

  it("does not reopen a closed LEGACY history", async () => {
    const thread = await prisma.chatThread.upsert({
      where: {
        businessId_driverId: { businessId: CARRIER, driverId: OTHER_DRIVER },
      },
      update: {},
      create: { businessId: CARRIER, driverId: OTHER_DRIVER },
    });

    const legacy = await prisma.supportTicket.create({
      data: {
        number: 9000,
        kind: "LEGACY",
        status: "CLOSED",
        close_outcome: "MIGRATED",
        closed_at: new Date(),
        subject: "Conversa anterior aos atendimentos",
        businessId: CARRIER,
        threadId: thread.id,
        driverId: OTHER_DRIVER,
        opened_via: "MIGRATION",
      },
    });

    const reopen = await call(
      "POST",
      `/chat/tickets/${legacy.id}/reopen`,
      users.admin.token,
      {},
    );

    expect(reopen.status).toBe(409);
    expect(reopen.body.code).toBe("SUPPORT_TICKET_LEGACY_READ_ONLY");
  });
});

describe("walls", () => {
  it("answers another company's ticket exactly like a missing one", async () => {
    const { ticketId } = await pendingTicket("Cliente Muro");

    const foreign = await call(
      "GET",
      `/chat/tickets/${ticketId}`,
      users.otherAdmin.token,
    );
    const missing = await call(
      "GET",
      `/chat/tickets/${randomUUID()}`,
      users.otherAdmin.token,
    );

    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual({
      code: "SUPPORT_TICKET_NOT_FOUND",
      message: "Atendimento não encontrado.",
    });
    expect(missing.body).toEqual(foreign.body);

    const foreignClose = await closeTicket(
      ticketId,
      { outcome: "APPROVED" },
      users.otherAdmin.token,
    );

    expect(foreignClose.status).toBe(404);
    expect(
      (
        await prisma.supportTicket.findUniqueOrThrow({
          where: { id: ticketId },
        })
      ).status,
    ).toBe("OPEN");

    const list = await call(
      "GET",
      "/chat/tickets?status=ALL",
      users.otherAdmin.token,
    );

    expect(
      list.body.data.some((ticket: { id: string }) => ticket.id === ticketId),
    ).toBe(false);
  });

  it("answers another driver's ticket like a missing one and lists only the driver's own, without the assignee", async () => {
    const { ticketId } = await pendingTicket("Cliente do João");

    const asOther = await call(
      "GET",
      `/chat/tickets/${ticketId}`,
      users.otherDriver.token,
    );
    const otherMessage = await call(
      "POST",
      `/chat/tickets/${ticketId}/messages`,
      users.otherDriver.token,
      {
        kind: "TEXT",
        body: "Não é meu",
      },
    );

    expect(asOther.status).toBe(404);
    expect(otherMessage.status).toBe(404);

    const own = await call(
      "GET",
      "/chat/tickets?status=ALL",
      users.driver.token,
    );

    expect(own.status).toBe(200);
    expect(own.body.data.length).toBeGreaterThan(0);
    expect(
      own.body.data.every(
        (ticket: Record<string, unknown>) => !("assignee" in ticket),
      ),
    ).toBe(true);

    const othersList = await call(
      "GET",
      "/chat/tickets?status=ALL",
      users.otherDriver.token,
    );

    expect(
      othersList.body.data.some(
        (ticket: { id: string }) => ticket.id === ticketId,
      ),
    ).toBe(false);

    // The tower's tools are not the driver's.
    const summary = await call(
      "GET",
      "/chat/tickets/summary",
      users.driver.token,
    );
    const events = await call(
      "GET",
      `/chat/tickets/${ticketId}/events`,
      users.driver.token,
    );
    const close = await closeTicket(
      ticketId,
      { outcome: "APPROVED" },
      users.driver.token,
    );

    expect(summary.status).toBe(403);
    expect(summary.body.code).toBe("PERMISSION_DENIED");
    expect(events.status).toBe(403);
    expect(close.status).toBe(403);
  });

  it("lets a read-only profile see and never write, and the MASTER read and never write", async () => {
    const { ticketId } = await pendingTicket("Cliente Leitura");

    const seen = await call(
      "GET",
      `/chat/tickets/${ticketId}`,
      users.readOnly.token,
    );

    expect(seen.status).toBe(200);
    expect(seen.body.data.permissions).toMatchObject({
      canWrite: false,
      canClose: false,
      canDecide: false,
      closeOutcomes: [],
    });

    const close = await closeTicket(
      ticketId,
      { outcome: "APPROVED" },
      users.readOnly.token,
    );

    expect(close.status).toBe(403);
    expect(close.body.code).toBe("PERMISSION_DENIED");

    const asMaster = await call(
      "GET",
      `/chat/tickets/${ticketId}?businessId=${CARRIER}`,
      users.master.token,
    );

    expect(asMaster.status, JSON.stringify(asMaster.body)).toBe(200);

    const masterClose = await closeTicket(
      ticketId,
      { outcome: "APPROVED" },
      users.master.token,
      `?businessId=${CARRIER}`,
    );

    expect(masterClose.status).toBe(403);
    expect(masterClose.body.code).toBe("MASTER_CHAT_READ_ONLY");

    const masterOpen = await openTicket(
      { driverId: DRIVER, subject: "Suporte", businessId: CARRIER },
      users.master.token,
    );

    expect(masterOpen.status).toBe(403);
    expect(masterOpen.body.code).toBe("MASTER_CHAT_READ_ONLY");

    expect(
      (
        await prisma.supportTicket.findUniqueOrThrow({
          where: { id: ticketId },
        })
      ).status,
    ).toBe("OPEN");
  });
});

describe("the alert sound preference (decision 14.6)", () => {
  it("defaults to on, is saved per person and follows them", async () => {
    const before = await call(
      "GET",
      "/notification/preferences",
      users.operator.token,
    );

    expect(before.status).toBe(200);
    expect(before.body.opsAlert).toEqual({ sound: true });

    const saved = await call(
      "PUT",
      "/notification/preferences",
      users.operator.token,
      {
        opsAlert: { sound: false },
      },
    );

    expect(saved.status, JSON.stringify(saved.body)).toBe(200);

    const after = await call(
      "GET",
      "/notification/preferences",
      users.operator.token,
    );
    const someoneElse = await call(
      "GET",
      "/notification/preferences",
      users.admin.token,
    );

    expect(after.body.opsAlert).toEqual({ sound: false });
    expect(someoneElse.body.opsAlert).toEqual({ sound: true });

    const empty = await call(
      "PUT",
      "/notification/preferences",
      users.operator.token,
      {},
    );

    expect(empty.status).toBe(400);
  });
});

describe("Abrir atendimento and the legacy routing", () => {
  it("opens the ticket of an occurrence that had none, from the panel, without naming the driver", async () => {
    const deliveryId = await inTransit("Cliente Painel");
    const panelReport = await report(
      deliveryId,
      PROBLEM_TYPE,
      users.operator.token,
    );

    expect(panelReport.body.data.ticket).toBeNull();

    const body = { deliveryId, occurrenceId: panelReport.body.data.id };
    const first = await openTicket(body, users.operator.token);
    const again = await openTicket(body, users.admin.token);

    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.data).toMatchObject({
      kind: "OCCURRENCE",
      driver: { id: DRIVER },
      occurrence: { id: panelReport.body.data.id },
      subject: "Avaria — Cliente Painel",
    });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({
      created: false,
      data: { id: first.body.data.id },
    });

    // A driver never opens an occurrence's ticket.
    const byDriver = await openTicket(body, users.driver.token);

    expect(byDriver.status).toBe(403);
  });

  it("files the driver's reply to the tower's recent message in that ticket", async () => {
    const opened = await openTicket(
      {
        driverId: OTHER_DRIVER,
        subject: "Combustível",
        message: { kind: "TEXT", body: "Abasteceu?" },
      },
      users.admin.token,
    );

    expect(opened.status, JSON.stringify(opened.body)).toBe(201);

    // The installed app knows no tickets: no ticketId, no delivery, no route.
    const reply = await call(
      "POST",
      "/chat/send-message",
      users.otherDriver.token,
      {
        driverIds: [OTHER_DRIVER],
        kind: "TEXT",
        body: "Sim, no posto da rodovia",
        clientSubmissionId: randomUUID(),
      },
    );

    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    expect(reply.body.data[0].ticket).toMatchObject({
      id: opened.body.data.id,
    });
    expect(reply.body.data[0].senderSide).toBe("DRIVER");
  });

  it("does not hand a driver another driver's ticket messages", async () => {
    const { ticketId } = await pendingTicket("Cliente Mensagens");

    const asOther = await call(
      "GET",
      `/chat/list-messages?ticketId=${ticketId}`,
      users.otherDriver.token,
    );

    expect(asOther.status).toBe(404);
    expect(asOther.body.code).toBe("SUPPORT_TICKET_NOT_FOUND");
  });
});
