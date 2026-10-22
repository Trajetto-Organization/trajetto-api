import { beforeEach, describe, expect, it, vi } from "vitest";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryDriverRepository } from "@/modules/driver/repositories/in-memory/in-memory-driver-repository";
import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import { InMemoryChatRepository } from "@/modules/chat/repositories/in-memory/in-memory-chat-repository";
import { InMemorySupportTicketRepository } from "@/modules/chat/repositories/in-memory/in-memory-support-ticket-repository";
import { InMemoryOpsAlertPreferenceRepository } from "@/modules/chat/repositories/in-memory/in-memory-ops-alert-preference-repository";

import { SendChatMessageUseCase } from "@/modules/chat/usecases/send-chat-message/send-chat-message-usecase";
import { OpenSupportTicketUseCase } from "@/modules/chat/usecases/tickets/open-support-ticket/open-support-ticket-usecase";
import { AssignSupportTicketUseCase } from "@/modules/chat/usecases/tickets/assign-support-ticket/assign-support-ticket-usecase";
import { CloseSupportTicketUseCase } from "@/modules/chat/usecases/tickets/close-support-ticket/close-support-ticket-usecase";
import { ReopenSupportTicketUseCase } from "@/modules/chat/usecases/tickets/reopen-support-ticket/reopen-support-ticket-usecase";
import { GetSupportTicketUseCase } from "@/modules/chat/usecases/tickets/get-support-ticket/get-support-ticket-usecase";
import { ListSupportTicketsUseCase } from "@/modules/chat/usecases/tickets/list-support-tickets/list-support-tickets-usecase";
import { ListSupportTicketEventsUseCase } from "@/modules/chat/usecases/tickets/list-support-ticket-events/list-support-ticket-events-usecase";
import { GetSupportTicketsSummaryUseCase } from "@/modules/chat/usecases/tickets/get-support-tickets-summary/get-support-tickets-summary-usecase";
import { ListTicketAssigneesUseCase } from "@/modules/chat/usecases/tickets/list-ticket-assignees/list-ticket-assignees-usecase";
import { MarkSupportTicketReadUseCase } from "@/modules/chat/usecases/tickets/mark-support-ticket-read/mark-support-ticket-read-usecase";
import { RepairUnticketedMessagesUseCase } from "@/modules/chat/usecases/tickets/repair-unticketed-messages/repair-unticketed-messages-usecase";
import { OpsAlertPreferenceUseCase } from "@/modules/chat/usecases/ops-alert-preference/ops-alert-preference-usecase";

import { sendChatReadEvent, sendSupportTicketEvent } from "@/websocket";

import type { User } from "@/modules/user/dtos/user-dto";
import type { Driver } from "@/modules/driver/dtos/driver-dto";
import type { CreateDeliveryProps } from "@/modules/delivery/dtos/delivery-dto";
import type { UploadService } from "@/shared/services/upload-service";
import type { OutboxService } from "@/shared/notifications/outbox-service";

/**
 * The support tickets' use cases on the in-memory twins (decision 14.5):
 * who may open, take, close, reopen and read a ticket, which company's
 * tickets they ever see, and the replays a double click or a retry makes.
 * The same paths run against Postgres in tests/E2E/support-ticket-*.test.ts.
 */
vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({}),
  },
}));

vi.mock("@/websocket", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/websocket")>()),
  sendSupportTicketEvent: vi.fn(),
  sendChatReadEvent: vi.fn(),
  sendChatMessageEvent: vi.fn(),
  sendChatDeliveredEvent: vi.fn(),
  getOnlineUserIds: vi.fn(async () => []),
}));

const A = "018f5200-0000-7000-8000-00000000000a";
const B = "018f5200-0000-7000-8000-00000000000b";

const OPERATOR = "018f5200-0000-7000-8000-0000000000a1";
const OPERATOR_2 = "018f5200-0000-7000-8000-0000000000a2";
const READER = "018f5200-0000-7000-8000-0000000000a3";
const REVOKED = "018f5200-0000-7000-8000-0000000000a4";
const DRIVER_USER = "018f5200-0000-7000-8000-0000000000a5";
const DRIVER_2_USER = "018f5200-0000-7000-8000-0000000000a6";
const MASTER = "018f5200-0000-7000-8000-0000000000a7";
const FOREIGN_OPERATOR = "018f5200-0000-7000-8000-0000000000b1";

const DRIVER = "018f5200-0000-7000-8000-0000000000d1";
const DRIVER_2 = "018f5200-0000-7000-8000-0000000000d2";
const FOREIGN_DRIVER = "018f5200-0000-7000-8000-0000000000d3";

const READ_ONLY_PROFILE = "018f5200-0000-7000-8000-0000000000e1";

const KEY_1 = "018f5200-0000-7000-8000-00000000f001";
const KEY_2 = "018f5200-0000-7000-8000-00000000f002";
const KEY_3 = "018f5200-0000-7000-8000-00000000f003";

const uploadStub = {
  resolvePresignedUploads: async (files: Array<{ key: string }>) =>
    files.map(({ key }) => ({ path: key })),
  getFileUrl: async (key: string) => `https://signed/${key}`,
} as unknown as UploadService;
const outbox = { publish: async () => undefined } as unknown as OutboxService;

let users: InMemoryUserRepository;
let drivers: InMemoryDriverRepository;
let deliveries: InMemoryDeliveryRepository;
let chat: InMemoryChatRepository;
let tickets: InMemorySupportTicketRepository;

beforeEach(() => {
  vi.clearAllMocks();

  users = new InMemoryUserRepository();
  drivers = new InMemoryDriverRepository();
  deliveries = new InMemoryDeliveryRepository();
  chat = new InMemoryChatRepository();
  tickets = new InMemorySupportTicketRepository(chat);

  users.profiles.set(READ_ONLY_PROFILE, { name: "Somente leitura" } as never);
  users.profilePermissions.set(READ_ONLY_PROFILE, [
    { permissionKey: "delivery_manage", canRead: true, canWrite: false },
  ] as never);

  const people: Array<Partial<User> & { created_at?: Date }> = [
    {
      id: OPERATOR,
      name: "Olga Torre",
      role: "BUSINESS_ADMIN",
      businessId: A,
      created_at: new Date(1),
    },
    {
      id: OPERATOR_2,
      name: "Bruno Torre",
      role: "BUSINESS_ADMIN",
      businessId: A,
      created_at: new Date(2),
    },
    {
      id: READER,
      name: "Rita Leitura",
      role: "BUSINESS_USER",
      businessId: A,
      profileAccessId: READ_ONLY_PROFILE,
    },
    {
      id: REVOKED,
      name: "Revogado",
      role: "BUSINESS_ADMIN",
      businessId: A,
      access_revoked: true,
    },
    {
      id: DRIVER_USER,
      name: "João Motorista",
      role: "BUSINESS_USER",
      businessId: A,
      driverId: DRIVER,
    },
    {
      id: DRIVER_2_USER,
      name: "Maria Motorista",
      role: "BUSINESS_USER",
      businessId: A,
      driverId: DRIVER_2,
    },
    { id: MASTER, name: "Suporte Trajetto", role: "MASTER", businessId: null },
    {
      id: FOREIGN_OPERATOR,
      name: "Fábio Outra",
      role: "BUSINESS_ADMIN",
      businessId: B,
    },
  ];

  for (const person of people) {
    users.user.push(person as User);
    chat.userDirectory.set(person.id!, {
      name: person.name!,
      driverId: person.driverId ?? null,
    });
  }

  const fleet: Array<Partial<Driver>> = [
    {
      id: DRIVER,
      name: "João Motorista",
      cnh: "111",
      businessId: A,
      status: "ACTIVE",
    },
    {
      id: DRIVER_2,
      name: "Maria Motorista",
      cnh: "222",
      businessId: A,
      status: "ACTIVE",
    },
    {
      id: FOREIGN_DRIVER,
      name: "De Outra Empresa",
      cnh: "333",
      businessId: B,
      status: "ACTIVE",
    },
  ];

  for (const driver of fleet) {
    drivers.drivers.push(driver as Driver);
    chat.driverDirectory.set(driver.id!, {
      name: driver.name!,
      cnh: driver.cnh!,
      businessId: driver.businessId,
      status: "ACTIVE",
    });
  }
});

const send = () =>
  new SendChatMessageUseCase(
    users,
    drivers,
    deliveries,
    chat,
    uploadStub,
    outbox,
    tickets,
  );
const open = () =>
  new OpenSupportTicketUseCase(
    users,
    drivers,
    deliveries,
    chat,
    tickets,
    {} as never,
    send(),
  );
const assign = () => new AssignSupportTicketUseCase(users, tickets);
const reopen = () => new ReopenSupportTicketUseCase(users, tickets);
const notifications = { createActivityIfEnabled: vi.fn() };

/** The tower's general ticket with the driver. */
async function generalTicket(key = KEY_1, driverId = DRIVER) {
  const { data } = await open().execute({
    userId: OPERATOR,
    idempotencyKey: key,
    driverId,
    subject: "Combustível da rota",
  });

  return data;
}

async function deliveryOf(
  businessId: string,
  driverId: string | null,
  recipient = "Mercado Sol",
) {
  const delivery = await deliveries.createDelivery({
    recipient_name: recipient,
    city: "São Paulo",
    uf: "SP",
    street: "Rua Um",
    businessId,
    shipperId: "018f5200-0000-7000-8000-0000000000c1",
  } as CreateDeliveryProps);

  delivery.driverId = driverId;
  delivery.status = "IN_TRANSIT";
  chat.deliveryDirectory.set(delivery.id!, {
    recipient_name: recipient,
    status: "IN_TRANSIT",
  });

  return delivery.id!;
}

describe("OpenSupportTicketUseCase", () => {
  it("opens the tower's ticket with the driver, numbered per company, with its trail and its event", async () => {
    const ticket = await generalTicket();

    expect(ticket).toMatchObject({
      number: 1,
      kind: "DRIVER",
      status: "OPEN",
      subject: "Combustível da rota",
    });
    expect(tickets.events.map((event) => event.type)).toEqual(["OPENED"]);
    expect(vi.mocked(sendSupportTicketEvent)).toHaveBeenCalledWith(
      A,
      DRIVER_USER,
      expect.objectContaining({ type: "ticket.opened" }),
      expect.anything(),
    );
  });

  it("answers a retried create with the same ticket, and a reused key for another driver with 409", async () => {
    const first = await generalTicket();

    const retried = await open().execute({
      userId: OPERATOR,
      idempotencyKey: KEY_1,
      driverId: DRIVER,
      subject: "Combustível da rota",
    });

    expect(retried).toMatchObject({ created: false, data: { id: first.id } });
    expect(tickets.tickets).toHaveLength(1);

    await expect(
      open().execute({
        userId: OPERATOR,
        idempotencyKey: KEY_1,
        driverId: DRIVER_2,
        subject: "Outro",
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "CHAT_SUBMISSION_CONFLICT",
    });
  });

  it("refuses without an Idempotency-Key, with both a delivery and a route, or without a subject", async () => {
    await expect(
      open().execute({ userId: OPERATOR, driverId: DRIVER, subject: "X" }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "IDEMPOTENCY_KEY_REQUIRED",
    });

    await expect(
      open().execute({
        userId: OPERATOR,
        idempotencyKey: KEY_1,
        deliveryId: "d",
        routeId: "r",
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "SUPPORT_TICKET_CONTEXT_CONFLICT",
    });

    await expect(
      open().execute({
        userId: OPERATOR,
        idempotencyKey: KEY_1,
        driverId: DRIVER,
        subject: "   ",
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "SUPPORT_TICKET_SUBJECT_REQUIRED",
    });

    await expect(
      open().execute({ userId: OPERATOR, idempotencyKey: KEY_1 }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "SUPPORT_TICKET_DRIVER_REQUIRED",
    });

    expect(tickets.tickets).toHaveLength(0);
  });

  it("is refused to the MASTER and to a read-only profile", async () => {
    await expect(
      open().execute({
        userId: MASTER,
        businessId: A,
        idempotencyKey: KEY_1,
        driverId: DRIVER,
        subject: "X",
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: "MASTER_CHAT_READ_ONLY" });

    await expect(
      open().execute({
        userId: READER,
        idempotencyKey: KEY_1,
        driverId: DRIVER,
        subject: "X",
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: "PERMISSION_DENIED" });

    expect(tickets.tickets).toHaveLength(0);
  });

  it("answers another company's driver or delivery as a missing one", async () => {
    await expect(
      open().execute({
        userId: OPERATOR,
        idempotencyKey: KEY_1,
        driverId: FOREIGN_DRIVER,
        subject: "X",
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: "CHAT_DRIVER_NOT_FOUND" });

    const foreignDelivery = await deliveryOf(B, FOREIGN_DRIVER);

    await expect(
      open().execute({
        userId: OPERATOR,
        idempotencyKey: KEY_2,
        deliveryId: foreignDelivery,
      }),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "CHAT_DELIVERY_NOT_FOUND",
    });
  });

  it("refuses a delivery that has no driver yet (400)", async () => {
    const unassigned = await deliveryOf(A, null);

    await expect(
      open().execute({
        userId: OPERATOR,
        idempotencyKey: KEY_1,
        deliveryId: unassigned,
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "SUPPORT_TICKET_NO_DRIVER",
    });
  });

  it("is a get-or-create about a delivery: one open ticket per delivery, in its driver's conversation", async () => {
    const deliveryId = await deliveryOf(A, DRIVER);

    const first = await open().execute({
      userId: OPERATOR,
      idempotencyKey: KEY_1,
      deliveryId,
    });
    const second = await open().execute({
      userId: OPERATOR_2,
      idempotencyKey: KEY_2,
      deliveryId,
    });

    expect(first).toMatchObject({
      created: true,
      data: { kind: "DELIVERY", subject: "Entrega — Mercado Sol" },
    });
    expect(second).toMatchObject({
      created: false,
      data: { id: first.data.id },
    });
    expect(tickets.tickets).toHaveLength(1);
    expect(tickets.tickets[0].driverId).toBe(DRIVER);
  });

  it("asks for the delivery when an occurrence is named alone", async () => {
    await expect(
      open().execute({
        userId: OPERATOR,
        idempotencyKey: KEY_1,
        driverId: DRIVER,
        occurrenceId: "o",
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "SUPPORT_TICKET_CONTEXT_REQUIRED",
    });
  });

  it("lets the driver open his own subject, ringing the tower, and only his own", async () => {
    const { data, created } = await open().execute({
      userId: DRIVER_USER,
      idempotencyKey: KEY_1,
    });

    expect(created).toBe(true);
    expect(data).toMatchObject({
      kind: "DRIVER",
      subject: "Conversa com João Motorista",
    });
    // The driver's view never says who handles it inside the company.
    expect(data).not.toHaveProperty("assignee");
    expect(vi.mocked(sendSupportTicketEvent)).toHaveBeenCalledWith(
      A,
      DRIVER_USER,
      expect.objectContaining({
        alert: expect.objectContaining({ reason: "DRIVER_OPENED" }),
      }),
      expect.anything(),
    );

    await expect(
      open().execute({
        userId: DRIVER_USER,
        idempotencyKey: KEY_2,
        driverId: DRIVER_2,
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "DRIVER_CHAT_OWN_THREAD",
    });

    await expect(
      open().execute({
        userId: DRIVER_USER,
        idempotencyKey: KEY_3,
        deliveryId: "d",
        occurrenceId: "o",
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: "PERMISSION_DENIED" });
  });
});

describe("AssignSupportTicketUseCase", () => {
  it("takes a ticket, and the same request again is a replay with no second trail entry", async () => {
    const ticket = await generalTicket();

    const taken = await assign().execute({
      userId: OPERATOR,
      ticketId: ticket.id,
      assigneeId: OPERATOR,
      expectedAssigneeId: null,
    });

    expect(taken).toMatchObject({
      replayed: false,
      data: { assignee: { id: OPERATOR, name: "Olga Torre" } },
    });

    const again = await assign().execute({
      userId: OPERATOR,
      ticketId: ticket.id,
      assigneeId: OPERATOR,
      expectedAssigneeId: null,
    });

    expect(again.replayed).toBe(true);
    expect(
      tickets.events.filter((event) => event.type === "ASSIGNED"),
    ).toHaveLength(1);
  });

  it("refuses a transfer made over a stale screen with 409 and who holds it now", async () => {
    const ticket = await generalTicket();
    await assign().execute({
      userId: OPERATOR,
      ticketId: ticket.id,
      assigneeId: OPERATOR,
      expectedAssigneeId: null,
    });

    await expect(
      assign().execute({
        userId: OPERATOR_2,
        ticketId: ticket.id,
        assigneeId: OPERATOR_2,
        expectedAssigneeId: null,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "SUPPORT_TICKET_ASSIGNEE_CHANGED",
    });

    expect(tickets.tickets[0].assigneeId).toBe(OPERATOR);
  });

  it("releases a ticket, recorded as UNASSIGNED", async () => {
    const ticket = await generalTicket();
    await assign().execute({
      userId: OPERATOR,
      ticketId: ticket.id,
      assigneeId: OPERATOR,
    });

    await assign().execute({
      userId: OPERATOR,
      ticketId: ticket.id,
      assigneeId: null,
      expectedAssigneeId: OPERATOR,
    });

    expect(tickets.tickets[0].assigneeId).toBeNull();
    expect(tickets.events[tickets.events.length - 1]?.type).toBe("UNASSIGNED");
  });

  it("only hands a ticket to an operator of this company: not a driver, a revoked or a foreign user", async () => {
    const ticket = await generalTicket();

    for (const candidate of [DRIVER_USER, REVOKED, FOREIGN_OPERATOR, READER]) {
      await expect(
        assign().execute({
          userId: OPERATOR,
          ticketId: ticket.id,
          assigneeId: candidate,
        }),
      ).rejects.toMatchObject({
        statusCode: 404,
        code: "SUPPORT_TICKET_ASSIGNEE_NOT_FOUND",
      });
    }

    expect(tickets.tickets[0].assigneeId).toBeNull();
  });

  it("refuses a closed ticket with its number", async () => {
    const ticket = await generalTicket();
    await tickets.close({
      id: ticket.id,
      businessId: A,
      closedById: OPERATOR,
      outcome: "RESOLVED",
      note: null,
      at: new Date(),
    });

    await expect(
      assign().execute({
        userId: OPERATOR,
        ticketId: ticket.id,
        assigneeId: OPERATOR,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "SUPPORT_TICKET_CLOSED" });
  });

  it("is the tower's: refused to the driver, the read-only profile and the MASTER; 404 to another company", async () => {
    const ticket = await generalTicket();
    const take = (userId: string, businessId?: string) =>
      assign().execute({
        userId,
        businessId,
        ticketId: ticket.id,
        assigneeId: OPERATOR,
      });

    await expect(take(DRIVER_USER)).rejects.toMatchObject({
      statusCode: 403,
      code: "PERMISSION_DENIED",
    });
    await expect(take(READER)).rejects.toMatchObject({
      statusCode: 403,
      code: "PERMISSION_DENIED",
    });
    await expect(take(MASTER, A)).rejects.toMatchObject({
      statusCode: 403,
      code: "MASTER_CHAT_READ_ONLY",
    });
    await expect(take(FOREIGN_OPERATOR)).rejects.toMatchObject({
      statusCode: 404,
      code: "SUPPORT_TICKET_NOT_FOUND",
    });

    expect(tickets.tickets[0].assigneeId).toBeNull();
  });
});

describe("CloseSupportTicketUseCase", () => {
  const decide = { execute: vi.fn() };
  const close = () =>
    new CloseSupportTicketUseCase(
      users,
      tickets,
      decide as never,
      notifications as never,
    );

  it("closes as resolved, taking the unassigned ticket for whoever closes it", async () => {
    const ticket = await generalTicket();

    const closed = await close().execute({
      userId: OPERATOR,
      ticketId: ticket.id,
      outcome: "RESOLVED",
      note: "  Resolvido por telefone  ",
    });

    expect(closed.replayed).toBe(false);
    expect(tickets.tickets[0]).toMatchObject({
      status: "CLOSED",
      assigneeId: OPERATOR,
      closedById: OPERATOR,
      close_outcome: "RESOLVED",
      close_note: "Resolvido por telefone",
    });
    expect(tickets.events.map((event) => event.type)).toEqual([
      "OPENED",
      "ASSIGNED",
      "CLOSED",
    ]);
    expect(decide.execute).not.toHaveBeenCalled();
  });

  it("records the delivery's activity when the ticket was about a delivery", async () => {
    const deliveryId = await deliveryOf(A, DRIVER);
    const { data } = await open().execute({
      userId: OPERATOR,
      idempotencyKey: KEY_1,
      deliveryId,
    });

    await close().execute({
      userId: OPERATOR,
      ticketId: data.id,
      outcome: "RESOLVED",
    });

    expect(notifications.createActivityIfEnabled).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: deliveryId, businessId: A }),
    );
  });

  it("a double click is a replay; another operator closing again hears who closed it (409)", async () => {
    const ticket = await generalTicket();
    await close().execute({
      userId: OPERATOR,
      ticketId: ticket.id,
      outcome: "RESOLVED",
    });

    const replay = await close().execute({
      userId: OPERATOR,
      ticketId: ticket.id,
      outcome: "RESOLVED",
    });
    expect(replay.replayed).toBe(true);

    await expect(
      close().execute({
        userId: OPERATOR_2,
        ticketId: ticket.id,
        outcome: "RESOLVED",
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "SUPPORT_TICKET_ALREADY_CLOSED",
    });
  });

  it("refuses APPROVED on a ticket with no authorization waiting", async () => {
    const ticket = await generalTicket();

    await expect(
      close().execute({
        userId: OPERATOR,
        ticketId: ticket.id,
        outcome: "APPROVED",
      }),
    ).rejects.toMatchObject({ code: "SUPPORT_TICKET_NOT_AUTHORIZATION" });
    expect(decide.execute).not.toHaveBeenCalled();
    expect(tickets.tickets[0].status).toBe("OPEN");
  });

  it("on a request waiting for the tower, refuses RESOLVED and hands APPROVED to the decision", async () => {
    const deliveryId = await deliveryOf(A, DRIVER);
    const thread = await chat.getOrCreateThread(A, DRIVER);
    const occurrenceId = "018f5200-0000-7000-8000-0000000000c9";
    const ticket = await tickets.create({
      businessId: A,
      threadId: thread.id,
      driverId: DRIVER,
      kind: "OCCURRENCE",
      subject: "Cliente ausente — Mercado Sol",
      deliveryId,
      occurrenceId,
      opened_via: "OCCURRENCE_REPORT",
    } as never);
    tickets.occurrenceDirectory.set(occurrenceId, {
      typeName: "Cliente ausente",
      authorization_status: "PENDING",
      created_at: new Date(),
    });

    await expect(
      close().execute({
        userId: OPERATOR,
        ticketId: ticket.id,
        outcome: "RESOLVED",
      }),
    ).rejects.toMatchObject({ code: "SUPPORT_TICKET_AUTHORIZATION_PENDING" });

    decide.execute.mockResolvedValueOnce({ replayed: false });

    const result = await close().execute({
      userId: OPERATOR,
      ticketId: ticket.id,
      outcome: "APPROVED",
      note: " ok ",
    });

    expect(decide.execute).toHaveBeenCalledWith({
      userId: OPERATOR,
      businessId: A,
      occurrenceId,
      decision: "APPROVED",
      note: "ok",
    });
    expect(result.decision).toEqual({ replayed: false });
  });

  it("is refused to the MASTER and the driver, and 404s another company's ticket", async () => {
    const ticket = await generalTicket();

    await expect(
      close().execute({
        userId: MASTER,
        businessId: A,
        ticketId: ticket.id,
        outcome: "RESOLVED",
      }),
    ).rejects.toMatchObject({ code: "MASTER_CHAT_READ_ONLY" });
    await expect(
      close().execute({
        userId: DRIVER_USER,
        ticketId: ticket.id,
        outcome: "RESOLVED",
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(
      close().execute({
        userId: FOREIGN_OPERATOR,
        ticketId: ticket.id,
        outcome: "RESOLVED",
      }),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "SUPPORT_TICKET_NOT_FOUND",
    });

    expect(tickets.tickets[0].status).toBe("OPEN");
  });
});

describe("ReopenSupportTicketUseCase", () => {
  async function closed(ticketId: string) {
    await tickets.close({
      id: ticketId,
      businessId: A,
      closedById: OPERATOR,
      outcome: "RESOLVED",
      note: "x",
      at: new Date(),
    });
  }

  it("reopens a closed ticket with the note in its trail; reopening an open one is a replay", async () => {
    const ticket = await generalTicket();
    await closed(ticket.id);

    const result = await reopen().execute({
      userId: OPERATOR,
      ticketId: ticket.id,
      note: "  Cliente ligou de novo ",
    });

    expect(result.replayed).toBe(false);
    expect(tickets.tickets[0]).toMatchObject({
      status: "OPEN",
      reopened_count: 1,
      closed_at: null,
      close_outcome: null,
    });
    expect(tickets.events[tickets.events.length - 1]).toMatchObject({
      type: "REOPENED",
      note: "Cliente ligou de novo",
    });

    const again = await reopen().execute({
      userId: OPERATOR,
      ticketId: ticket.id,
    });
    expect(again.replayed).toBe(true);
    expect(tickets.tickets[0].reopened_count).toBe(1);
  });

  it("never reopens the legacy history (409)", async () => {
    const thread = await chat.getOrCreateThread(A, DRIVER);
    const legacy = await tickets.create({
      businessId: A,
      threadId: thread.id,
      driverId: DRIVER,
      kind: "LEGACY",
      subject: "Conversa anterior",
      opened_via: "MIGRATION",
    } as never);
    await closed(legacy.id);

    await expect(
      reopen().execute({ userId: OPERATOR, ticketId: legacy.id }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "SUPPORT_TICKET_LEGACY_READ_ONLY",
    });
  });

  it("sends the tower to the delivery's open ticket instead of opening a second one (409)", async () => {
    const deliveryId = await deliveryOf(A, DRIVER);
    const { data: first } = await open().execute({
      userId: OPERATOR,
      idempotencyKey: KEY_1,
      deliveryId,
    });
    await closed(first.id);
    await open().execute({
      userId: OPERATOR,
      idempotencyKey: KEY_2,
      deliveryId,
    });

    await expect(
      reopen().execute({ userId: OPERATOR, ticketId: first.id }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "SUPPORT_TICKET_OPEN_EXISTS",
    });
    expect(tickets.tickets.find((row) => row.id === first.id)?.status).toBe(
      "CLOSED",
    );
  });

  it("is the tower's: refused to the driver; 404 to another company", async () => {
    const ticket = await generalTicket();
    await closed(ticket.id);

    await expect(
      reopen().execute({ userId: DRIVER_USER, ticketId: ticket.id }),
    ).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    await expect(
      reopen().execute({ userId: FOREIGN_OPERATOR, ticketId: ticket.id }),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "SUPPORT_TICKET_NOT_FOUND",
    });
  });
});

describe("reading tickets", () => {
  const get = () =>
    new GetSupportTicketUseCase(users, tickets, {} as never, uploadStub);
  const list = () => new ListSupportTicketsUseCase(users, tickets);

  it("tells the operator, the read-only profile and the driver what each may do", async () => {
    const ticket = await generalTicket();

    const asOperator = await get().execute({
      userId: OPERATOR,
      ticketId: ticket.id,
    });
    expect(asOperator.permissions).toEqual({
      canWrite: true,
      canAssign: true,
      canClose: true,
      canReopen: false,
      canDecide: false,
      closeOutcomes: ["RESOLVED"],
    });
    expect(asOperator).toMatchObject({ occurrenceDetail: null });

    const asReader = await get().execute({
      userId: READER,
      ticketId: ticket.id,
    });
    expect(asReader.permissions).toMatchObject({
      canWrite: false,
      canAssign: false,
      canClose: false,
      closeOutcomes: [],
    });

    const asDriver = await get().execute({
      userId: DRIVER_USER,
      ticketId: ticket.id,
    });
    expect(asDriver).not.toHaveProperty("assignee");
    expect(asDriver.permissions).toMatchObject({
      canWrite: true,
      canAssign: false,
      canClose: false,
    });
  });

  it("answers a colleague's ticket to a driver, and any ticket to another company, as missing", async () => {
    const ticket = await generalTicket();

    await expect(
      get().execute({ userId: DRIVER_2_USER, ticketId: ticket.id }),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "SUPPORT_TICKET_NOT_FOUND",
    });
    await expect(
      get().execute({ userId: FOREIGN_OPERATOR, ticketId: ticket.id }),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "SUPPORT_TICKET_NOT_FOUND",
    });
  });

  it("lists the company's tickets with the requester's unread and the filter counts", async () => {
    const mine = await generalTicket(KEY_1, DRIVER);
    await generalTicket(KEY_2, DRIVER_2);
    await assign().execute({
      userId: OPERATOR,
      ticketId: mine.id,
      assigneeId: OPERATOR,
    });
    // The driver answers in his ticket: one unread for the tower.
    await send().execute({
      userId: DRIVER_USER,
      ticketId: mine.id,
      kind: "TEXT",
      body: "Já abasteci.",
    } as never);

    const all = await list().execute({
      userId: OPERATOR,
      status: "OPEN",
      scope: "ALL",
      page: 1,
      pageSize: 10,
    });

    expect(all.total).toBe(2);
    expect(all.counts).toMatchObject({
      open: 2,
      unassigned: 1,
      mine: 1,
      unreadOpen: 1,
    });
    expect(all.data.find((row) => row.id === mine.id)).toMatchObject({
      unreadCount: 1,
    });

    const onlyMine = await list().execute({
      userId: OPERATOR,
      status: "OPEN",
      scope: "MINE",
      page: 1,
      pageSize: 10,
    });
    expect(onlyMine.data.map((row) => row.id)).toEqual([mine.id]);

    // Another company sees none of them.
    const foreign = await list().execute({
      userId: FOREIGN_OPERATOR,
      status: "ALL",
      scope: "ALL",
      page: 1,
      pageSize: 10,
    });
    expect(foreign.total).toBe(0);
  });

  it("lists only the driver's own tickets, in his view, whatever scope he asks", async () => {
    await generalTicket(KEY_1, DRIVER);
    await generalTicket(KEY_2, DRIVER_2);

    const own = await list().execute({
      userId: DRIVER_USER,
      status: "ALL",
      scope: "UNASSIGNED",
      driverId: DRIVER_2,
      page: 1,
      pageSize: 10,
    });

    expect(own.total).toBe(1);
    expect(own.data[0]).not.toHaveProperty("assignee");
    expect(own.counts.open).toBe(1);
  });

  it("asks the MASTER to pick a company (400)", async () => {
    await expect(
      list().execute({
        userId: MASTER,
        status: "ALL",
        scope: "ALL",
        page: 1,
        pageSize: 10,
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "CHAT_BUSINESS_REQUIRED",
    });
  });
});

describe("the tower's side panels", () => {
  it("lists a ticket's trail in order, never to a driver nor another company", async () => {
    const ticket = await generalTicket();
    await assign().execute({
      userId: OPERATOR,
      ticketId: ticket.id,
      assigneeId: OPERATOR,
    });

    const events = new ListSupportTicketEventsUseCase(users, tickets);

    const trail = await events.execute({
      userId: OPERATOR_2,
      ticketId: ticket.id,
    });
    expect(trail.data.map((event) => event.type)).toEqual([
      "OPENED",
      "ASSIGNED",
    ]);
    expect(trail.data[1]).toMatchObject({
      actor_name: "Olga Torre",
      target_user_name: "Olga Torre",
    });

    await expect(
      events.execute({ userId: DRIVER_USER, ticketId: ticket.id }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "PERMISSION_DENIED",
    });
    await expect(
      events.execute({ userId: FOREIGN_OPERATOR, ticketId: ticket.id }),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "SUPPORT_TICKET_NOT_FOUND",
    });
  });

  it("counts the balloon for the requester, inside the company, and not for drivers", async () => {
    const ticket = await generalTicket(KEY_1, DRIVER);
    await generalTicket(KEY_2, DRIVER_2);
    await assign().execute({
      userId: OPERATOR_2,
      ticketId: ticket.id,
      assigneeId: OPERATOR_2,
    });

    const summary = new GetSupportTicketsSummaryUseCase(users, tickets);

    await expect(
      summary.execute({ userId: OPERATOR_2 }),
    ).resolves.toMatchObject({ open: 2, unassigned: 1, mine: 1 });
    await expect(
      summary.execute({ userId: MASTER, businessId: A }),
    ).resolves.toMatchObject({ open: 2, mine: 0 });
    await expect(
      summary.execute({ userId: FOREIGN_OPERATOR }),
    ).resolves.toMatchObject({ open: 0 });
    await expect(
      summary.execute({ userId: DRIVER_USER }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "PERMISSION_DENIED",
    });
  });

  it("offers this company's live operators only, by name, filtered by the search", async () => {
    const assignees = new ListTicketAssigneesUseCase(users);

    const all = await assignees.execute({ userId: OPERATOR });
    expect(all.data).toEqual([
      { id: OPERATOR_2, name: "Bruno Torre" },
      { id: OPERATOR, name: "Olga Torre" },
    ]);

    const searched = await assignees.execute({
      userId: OPERATOR,
      search: "  olga ",
    });
    expect(searched.data.map((row) => row.id)).toEqual([OPERATOR]);

    await expect(
      assignees.execute({ userId: DRIVER_USER }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "PERMISSION_DENIED",
    });
  });
});

describe("MarkSupportTicketReadUseCase", () => {
  const markRead = () => new MarkSupportTicketReadUseCase(users, tickets);

  it("advances the requester's cursor, clamped to now, and tells the driver's phone", async () => {
    const ticket = await generalTicket();
    const future = new Date(Date.now() + 60 * 60 * 1000);

    const result = await markRead().execute({
      userId: OPERATOR,
      ticketId: ticket.id,
      readAt: future,
    });

    expect(result.last_read_at.getTime()).toBeLessThanOrEqual(Date.now());
    expect(tickets.reads).toEqual([
      {
        ticketId: ticket.id,
        userId: OPERATOR,
        last_read_at: result.last_read_at,
      },
    ]);
    expect(vi.mocked(sendChatReadEvent)).toHaveBeenCalledWith(
      A,
      DRIVER_USER,
      expect.objectContaining({ ticketId: ticket.id, userId: OPERATOR }),
    );
  });

  it("never rewinds the cursor", async () => {
    const ticket = await generalTicket();
    await markRead().execute({ userId: OPERATOR, ticketId: ticket.id });
    const later = tickets.reads[0].last_read_at;

    await markRead().execute({
      userId: OPERATOR,
      ticketId: ticket.id,
      readAt: new Date(later.getTime() - 60_000),
    });

    expect(tickets.reads[0].last_read_at).toEqual(later);
  });

  it("moves nothing when the MASTER looks, and 404s a colleague's ticket for a driver", async () => {
    const ticket = await generalTicket();

    await markRead().execute({
      userId: MASTER,
      businessId: A,
      ticketId: ticket.id,
    });
    expect(tickets.reads).toHaveLength(0);
    expect(vi.mocked(sendChatReadEvent)).not.toHaveBeenCalled();

    await expect(
      markRead().execute({ userId: DRIVER_2_USER, ticketId: ticket.id }),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "SUPPORT_TICKET_NOT_FOUND",
    });
  });
});

describe("RepairUnticketedMessagesUseCase", () => {
  const repair = () =>
    new RepairUnticketedMessagesUseCase(
      tickets,
      chat,
      deliveries,
      users,
      drivers,
    );

  async function unticketed(
    props: { deliveryId?: string | null; broadcast?: boolean } = {},
  ) {
    const thread = await chat.getOrCreateThread(A, DRIVER);

    return chat.createMessage({
      kind: "TEXT",
      body: "Mensagem da imagem anterior",
      attachment_key: null,
      duration_ms: null,
      deliveryId: props.deliveryId ?? null,
      broadcast_id: props.broadcast
        ? "018f5200-0000-7000-8000-00000000bb01"
        : null,
      client_submission_id: null,
      threadId: thread.id,
      senderId: DRIVER_USER,
    } as never);
  }

  beforeEach(() => {
    // This database ran the backfill a minute ago: older messages were filed.
    tickets.backfilledAt = new Date(Date.now() - 60_000);
  });

  it("files a driver's loose message in a new general ticket, once", async () => {
    const message = await unticketed();

    await expect(repair().execute()).resolves.toBe(1);
    expect(tickets.tickets).toHaveLength(1);
    expect(tickets.tickets[0]).toMatchObject({
      kind: "DRIVER",
      subject: "Conversa com João Motorista",
      opened_via: "LEGACY_ROUTING",
    });
    expect(chat.messages.find((row) => row.id === message.id)?.ticketId).toBe(
      tickets.tickets[0].id,
    );
    expect(tickets.tickets[0].last_driver_message_at).toEqual(
      message.created_at,
    );

    await expect(repair().execute()).resolves.toBe(0);
    expect(tickets.tickets).toHaveLength(1);
  });

  it("files a message about a delivery in that delivery's ticket", async () => {
    const deliveryId = await deliveryOf(A, DRIVER);
    await unticketed({ deliveryId });

    await repair().execute();

    expect(tickets.tickets[0]).toMatchObject({ kind: "DELIVERY", deliveryId });
  });

  it("leaves mass notices and messages from before the backfill alone", async () => {
    await unticketed({ broadcast: true });
    tickets.backfilledAt = new Date(Date.now() + 60_000);
    await unticketed();

    await expect(repair().execute()).resolves.toBe(0);
    expect(tickets.tickets).toHaveLength(0);
  });
});

describe("OpsAlertPreferenceUseCase", () => {
  let preferences: InMemoryOpsAlertPreferenceRepository;

  beforeEach(() => {
    preferences = new InMemoryOpsAlertPreferenceRepository();
    preferences.users.set(OPERATOR, {});
  });

  it("reads the column's default (on) and writes only a change", async () => {
    const useCase = new OpsAlertPreferenceUseCase(preferences);
    const setSound = vi.spyOn(preferences, "setSound");

    await expect(useCase.get(OPERATOR)).resolves.toEqual({ sound: true });

    await expect(useCase.update(OPERATOR, { sound: true })).resolves.toEqual({
      sound: true,
    });
    expect(setSound).not.toHaveBeenCalled();

    await expect(useCase.update(OPERATOR, { sound: false })).resolves.toEqual({
      sound: false,
    });
    await expect(useCase.get(OPERATOR)).resolves.toEqual({ sound: false });
  });

  it("answers 404 USER_NOT_FOUND for an unknown user, reading and writing", async () => {
    const useCase = new OpsAlertPreferenceUseCase(preferences);

    await expect(useCase.get("nobody")).rejects.toMatchObject({
      statusCode: 404,
      code: "USER_NOT_FOUND",
    });
    await expect(
      useCase.update("nobody", { sound: false }),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "USER_NOT_FOUND",
    });
  });
});
