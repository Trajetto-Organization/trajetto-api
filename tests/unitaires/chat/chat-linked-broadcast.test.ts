import { describe, expect, it, vi } from "vitest";

import { SendChatMessageUseCase } from "@/modules/chat/usecases/send-chat-message/send-chat-message-usecase";
import { ListChatMessagesUseCase } from "@/modules/chat/usecases/list-chat-messages/list-chat-messages-usecase";
import { ListChatRecipientsUseCase } from "@/modules/chat/usecases/list-chat-recipients/list-chat-recipients-usecase";

import { InMemoryChatRepository } from "@/modules/chat/repositories/in-memory/in-memory-chat-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryDriverRepository } from "@/modules/driver/repositories/in-memory/in-memory-driver-repository";
import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";

import { ChatMessageNotFoundError } from "@/modules/chat/usecases/errors/chat-errors";
import { sendChatMessageSchema } from "@/schemas/send-chat-message-schema";

import type { UploadService } from "@/shared/services/upload-service";
import type { OutboxService } from "@/shared/notifications/outbox-service";
import type { User } from "@/modules/user/dtos/user-dto";
import type { Driver } from "@/modules/driver/dtos/driver-dto";
import type { CreateDeliveryProps } from "@/modules/delivery/dtos/delivery-dto";

/**
 * Decisions 6.7 and 6.8 on the chat's own rules, against the in-memory twins.
 *
 * - 6.7: one thread per driver, each message tagged with the route (and the
 *   delivery) it was about; the history filters by either.
 * - 6.8: a mass notice goes to drivers who can read it, says what happened to
 *   each one, and a key — even for a single recipient — makes a retry, or
 *   two replicas racing, answer the same message instead of a 500 or a copy.
 */
const BUSINESS = "018f0000-0000-7000-8000-00000000c00b";
const OTHER_BUSINESS = "018f0000-0000-7000-8000-00000000c00c";

const MANAGER = "018f0000-0000-7000-8000-00000000c0a1";
const MASTER = "018f0000-0000-7000-8000-00000000c0a2";

const JOAO = "018f0000-0000-7000-8000-00000000c0d1";
const MARIA = "018f0000-0000-7000-8000-00000000c0d2";
const NO_APP = "018f0000-0000-7000-8000-00000000c0d3";
const REVOKED = "018f0000-0000-7000-8000-00000000c0d4";
const INACTIVE = "018f0000-0000-7000-8000-00000000c0d5";
const FOREIGN = "018f0000-0000-7000-8000-00000000c0d6";
const BRANCH_OFF = "018f0000-0000-7000-8000-00000000c0d7";

const JOAO_USER = "018f0000-0000-7000-8000-00000000c0e1";
const MARIA_USER = "018f0000-0000-7000-8000-00000000c0e2";
const REVOKED_USER = "018f0000-0000-7000-8000-00000000c0e4";
const INACTIVE_USER = "018f0000-0000-7000-8000-00000000c0e5";
const FOREIGN_USER = "018f0000-0000-7000-8000-00000000c0e6";
const BRANCH_OFF_USER = "018f0000-0000-7000-8000-00000000c0e7";
const FOREIGN_MANAGER = "018f0000-0000-7000-8000-00000000c0a3";

const ROUTE_JOAO = "018f0000-0000-7000-8000-00000000c0f1";
const ROUTE_MARIA = "018f0000-0000-7000-8000-00000000c0f2";
const ROUTE_FOREIGN = "018f0000-0000-7000-8000-00000000c0f3";
const RELEASED_JOAO = "018f0000-0000-7000-8000-00000000c0f4";

const KEY = "018f0000-0000-7000-8000-00000000c1a1";

vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({}),
  },
}));

vi.mock("@/websocket", () => ({
  sendChatMessageEvent: vi.fn(),
  sendChatReadEvent: vi.fn(),
  sendChatDeliveredEvent: vi.fn(),
  getOnlineUserIds: vi.fn(async () => []),
}));

const uploads = {
  resolvePresignedUploads: async (files: Array<{ key: string }>) =>
    files.map(({ key }) => ({ path: key })),
  getFileUrl: async (key: string) => `http://storage.local/${key}`,
} as unknown as UploadService;

function outboxRecorder() {
  const published: Array<{ payload: Record<string, unknown> }> = [];

  return {
    published,
    stub: {
      publish: async (
        _tx: unknown,
        event: { payload: Record<string, unknown> },
      ) => {
        published.push(event);
      },
    } as unknown as OutboxService,
  };
}

function world() {
  const users = new InMemoryUserRepository();
  const drivers = new InMemoryDriverRepository();
  const deliveries = new InMemoryDeliveryRepository();
  const chat = new InMemoryChatRepository();
  const outbox = outboxRecorder();

  const staff: Array<Partial<User>> = [
    {
      id: MANAGER,
      name: "Gestora",
      role: "BUSINESS_ADMIN",
      businessId: BUSINESS,
    },
    { id: MASTER, name: "Suporte", role: "MASTER", businessId: null },
    {
      id: FOREIGN_MANAGER,
      name: "Gestor alheio",
      role: "BUSINESS_ADMIN",
      businessId: OTHER_BUSINESS,
    },
  ];

  const driverRows: Array<{
    id: string;
    name: string;
    businessId: string;
    status: "ACTIVE" | "INACTIVE";
    user?: { id: string; revoked?: boolean };
    branch?: { is_active: boolean };
  }> = [
    {
      id: JOAO,
      name: "João",
      businessId: BUSINESS,
      status: "ACTIVE",
      user: { id: JOAO_USER },
    },
    {
      id: MARIA,
      name: "Maria",
      businessId: BUSINESS,
      status: "ACTIVE",
      user: { id: MARIA_USER },
    },
    {
      id: NO_APP,
      name: "Beto Sem App",
      businessId: BUSINESS,
      status: "ACTIVE",
    },
    {
      id: REVOKED,
      name: "Carla Bloqueada",
      businessId: BUSINESS,
      status: "ACTIVE",
      user: { id: REVOKED_USER, revoked: true },
    },
    {
      id: INACTIVE,
      name: "Davi Inativo",
      businessId: BUSINESS,
      status: "INACTIVE",
      user: { id: INACTIVE_USER },
    },
    {
      id: FOREIGN,
      name: "Estranho",
      businessId: OTHER_BUSINESS,
      status: "ACTIVE",
      user: { id: FOREIGN_USER },
    },
    {
      // Active, with an account — but his branch was deactivated, so the
      // login refuses him (AUTH_BRANCH_INACTIVE) and he reads nothing.
      id: BRANCH_OFF,
      name: "Fábio Filial Inativa",
      businessId: BUSINESS,
      status: "ACTIVE",
      user: { id: BRANCH_OFF_USER },
      branch: { is_active: false },
    },
  ];

  for (const person of staff) {
    users.user.push(person as User);
    chat.userDirectory.set(person.id!, { name: person.name!, driverId: null });
  }

  for (const row of driverRows) {
    drivers.drivers.push({
      id: row.id,
      name: row.name,
      cnh: `cnh-${row.name}`,
      businessId: row.businessId,
      status: row.status,
      branch: row.branch,
    } as Driver);

    chat.driverDirectory.set(row.id, {
      name: row.name,
      cnh: `cnh-${row.name}`,
      businessId: row.businessId,
      status: row.status,
      branch: row.branch ?? null,
    });

    if (row.user) {
      users.user.push({
        id: row.user.id,
        name: row.name,
        role: "BUSINESS_USER",
        businessId: row.businessId,
        driverId: row.id,
        access_revoked: row.user.revoked ?? false,
      } as User);

      chat.userDirectory.set(row.user.id, {
        name: row.name,
        driverId: row.id,
        access_revoked: row.user.revoked ?? false,
        businessId: row.businessId,
      });
    }
  }

  const route = (
    id: string,
    driverId: string,
    code: number,
    status: "RELEASED" | "IN_PROGRESS",
    businessId = BUSINESS,
  ) =>
    chat.routes.push({
      id,
      businessId,
      driverId,
      code,
      name: `Rota ${code}`,
      status,
      started_at: status === "IN_PROGRESS" ? new Date() : null,
      created_at: new Date(),
    });

  route(ROUTE_JOAO, JOAO, 12, "IN_PROGRESS");
  route(ROUTE_MARIA, MARIA, 13, "IN_PROGRESS");
  route(RELEASED_JOAO, JOAO, 14, "RELEASED");
  route(ROUTE_FOREIGN, FOREIGN, 99, "IN_PROGRESS", OTHER_BUSINESS);

  const send = new SendChatMessageUseCase(
    users,
    drivers,
    deliveries,
    chat,
    uploads,
    outbox.stub,
  );

  return { users, drivers, deliveries, chat, outbox, send };
}

describe("a message tagged with its route (6.7)", () => {
  it("takes the route the driver is running when nobody names one", async () => {
    const { chat, send } = world();

    const { data } = await send.execute({
      userId: MANAGER,
      driverIds: [JOAO],
      kind: "TEXT",
      body: "Tudo certo na rota?",
    });

    expect(chat.messages[0].routeId).toBe(ROUTE_JOAO);
    expect(data[0].route).toEqual({
      id: ROUTE_JOAO,
      code: 12,
      name: "Rota 12",
    });
  });

  it("takes the route that carries the delivery in the chip over the running one", async () => {
    const { chat, deliveries, send } = world();

    const delivery = await deliveries.createDelivery({
      recipient_name: "Padaria",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      businessId: BUSINESS,
      shipperId: "018f0000-0000-7000-8000-00000000c0b1",
    } as CreateDeliveryProps);

    chat.routeStops.push({
      id: "stop-1",
      routeId: RELEASED_JOAO,
      deliveryId: delivery.id!,
      created_at: new Date(),
    });

    await send.execute({
      userId: MANAGER,
      driverIds: [JOAO],
      kind: "TEXT",
      body: "Sobre esta entrega",
      deliveryId: delivery.id!,
    });

    expect(chat.messages[0].routeId).toBe(RELEASED_JOAO);
  });

  it("refuses a route of another company as missing, and writes nothing", async () => {
    const { chat, send } = world();

    await expect(
      send.execute({
        userId: MANAGER,
        driverIds: [JOAO],
        kind: "TEXT",
        body: "oi",
        routeId: ROUTE_FOREIGN,
      }),
    ).rejects.toMatchObject({ code: "CHAT_ROUTE_NOT_FOUND", statusCode: 404 });

    expect(chat.messages).toHaveLength(0);
  });

  it("refuses a route of another driver of the same company", async () => {
    const { send } = world();

    await expect(
      send.execute({
        userId: MANAGER,
        driverIds: [JOAO],
        kind: "TEXT",
        body: "oi",
        routeId: ROUTE_MARIA,
      }),
    ).rejects.toMatchObject({ code: "CHAT_ROUTE_OTHER_DRIVER" });
  });

  it("tags each copy of a mass notice with that driver's own route", async () => {
    const { chat, send } = world();

    await send.execute({
      userId: MANAGER,
      driverIds: [JOAO, MARIA],
      kind: "TEXT",
      body: "Balança na BR-101",
    });

    const byThread = new Map(
      chat.threads.map((thread) => [thread.id, thread.driverId]),
    );

    expect(
      Object.fromEntries(
        chat.messages.map((message) => [
          byThread.get(message.threadId),
          message.routeId,
        ]),
      ),
    ).toEqual({ [JOAO]: ROUTE_JOAO, [MARIA]: ROUTE_MARIA });
  });

  it("filters the history by route and by delivery, and refuses an anchor the filter hides", async () => {
    const { chat, users, drivers, send } = world();

    await send.execute({
      userId: MANAGER,
      driverIds: [JOAO],
      kind: "TEXT",
      body: "na rota 12",
    });

    // He finished route 12; the next message is about no route.
    chat.routes.find((route) => route.id === ROUTE_JOAO)!.status = "COMPLETED";

    await send.execute({
      userId: MANAGER,
      driverIds: [JOAO],
      kind: "TEXT",
      body: "fora de rota",
    });

    const list = new ListChatMessagesUseCase(users, chat, uploads, drivers);

    const onRoute = await list.execute({
      userId: MANAGER,
      driverId: JOAO,
      limit: 30,
      routeId: ROUTE_JOAO,
    });

    expect(onRoute.data.map((message) => message.body)).toEqual(["na rota 12"]);

    const outside = chat.messages.find(
      (message) => message.body === "fora de rota",
    )!;

    await expect(
      list.execute({
        userId: MANAGER,
        driverId: JOAO,
        limit: 30,
        routeId: ROUTE_JOAO,
        aroundMessageId: outside.id,
      }),
    ).rejects.toBeInstanceOf(ChatMessageNotFoundError);
  });
});

describe("a mass notice (6.8)", () => {
  it("skips drivers who cannot read it and says so per recipient", async () => {
    const { chat, outbox, send } = world();

    const result = await send.execute({
      userId: MANAGER,
      driverIds: [JOAO, NO_APP, REVOKED, BRANCH_OFF],
      kind: "TEXT",
      body: "Balança na BR-101",
      broadcastKey: KEY,
    });

    expect(
      result.outcomes.map(({ driverId, status }) => [driverId, status]),
    ).toEqual([
      [JOAO, "SENT"],
      [NO_APP, "SKIPPED_NO_APP"],
      [REVOKED, "SKIPPED_NO_APP"],
      // Before: SENT, rung, and unable to log in to read it.
      [BRANCH_OFF, "SKIPPED_NO_APP"],
    ]);
    expect(result.summary).toEqual({
      sent: 1,
      alreadySent: 0,
      skippedNoApp: 3,
    });

    // Before: three messages, three threads, and a toast saying "3 enviados".
    expect(chat.messages).toHaveLength(1);
    expect(chat.threads.map((thread) => thread.driverId)).toEqual([JOAO]);
    expect(outbox.published).toHaveLength(1);
  });

  it("counts the same driver twice as one recipient", async () => {
    const { chat, send } = world();

    await send.execute({
      userId: MANAGER,
      driverIds: [JOAO, JOAO],
      kind: "TEXT",
      body: "Repetido",
    });

    expect(chat.messages).toHaveLength(1);

    // And the wire schema dedupes before the use case sees it.
    const parsed = sendChatMessageSchema.parse({
      driverIds: [JOAO, JOAO, MARIA],
      kind: "TEXT",
      body: "oi",
    });

    expect(parsed.driverIds).toEqual([JOAO, MARIA]);
  });

  it("holds the fifty-recipient ceiling to distinct drivers, not to the raw list", () => {
    const distinct = Array.from(
      { length: 50 },
      (_, index) =>
        `018f0000-0000-7000-8000-${String(index).padStart(12, "0")}`,
    );

    // Fifty drivers, one of them named twice: still fifty recipients. The
    // max used to run before the dedupe and refused this.
    const repeated = sendChatMessageSchema.safeParse({
      driverIds: [...distinct, distinct[0]],
      kind: "TEXT",
      body: "oi",
    });

    expect(repeated.success, JSON.stringify(repeated.error?.issues)).toBe(true);
    expect(repeated.success && repeated.data.driverIds).toHaveLength(50);

    const tooMany = sendChatMessageSchema.safeParse({
      driverIds: [...distinct, "018f0000-0000-7000-8000-0000000009ff"],
      kind: "TEXT",
      body: "oi",
    });

    expect(tooMany.success).toBe(false);
    expect(tooMany.error?.issues[0].message).toBe(
      "No máximo 50 motoristas por aviso em massa.",
    );
  });

  it("reaches every active driver with the app when the audience is everyone", async () => {
    const { chat, send } = world();

    const result = await send.execute({
      userId: MANAGER,
      audience: "ALL_ACTIVE_WITH_APP",
      kind: "TEXT",
      body: "Reunião às 7h",
      broadcastKey: KEY,
    });

    // Fábio (inactive branch) is not in "everyone": he cannot log in.
    expect(result.outcomes.map((outcome) => outcome.driverId).sort()).toEqual(
      [JOAO, MARIA].sort(),
    );
    expect(
      new Set(chat.messages.map((message) => message.broadcast_id)),
    ).toEqual(new Set([KEY]));

    // Retried after a lost answer: nobody is rung twice.
    const again = await send.execute({
      userId: MANAGER,
      audience: "ALL_ACTIVE_WITH_APP",
      kind: "TEXT",
      body: "Reunião às 7h",
      broadcastKey: KEY,
    });

    expect(again.summary).toEqual({ sent: 0, alreadySent: 2, skippedNoApp: 0 });
    expect(chat.messages).toHaveLength(2);
  });

  it("refuses everyone without a key, and an audience with nobody in it", async () => {
    const { chat, send } = world();

    await expect(
      send.execute({
        userId: MANAGER,
        audience: "ALL_ACTIVE_WITH_APP",
        kind: "TEXT",
        body: "sem chave",
      }),
    ).rejects.toMatchObject({ code: "CHAT_BROADCAST_KEY_REQUIRED" });

    for (const [, driver] of chat.driverDirectory) driver.status = "INACTIVE";

    await expect(
      send.execute({
        userId: MANAGER,
        audience: "ALL_ACTIVE_WITH_APP",
        kind: "TEXT",
        body: "ninguém",
        broadcastKey: KEY,
      }),
    ).rejects.toMatchObject({ code: "CHAT_BROADCAST_EMPTY" });

    expect(chat.messages).toHaveLength(0);
  });

  it("refuses an audience larger than one notice may reach", async () => {
    const { chat, send } = world();

    for (let index = 0; index < 500; index += 1) {
      const id = `018f0000-0000-7000-8000-${String(index).padStart(12, "0")}`;

      chat.driverDirectory.set(id, {
        name: `Motorista ${index}`,
        cnh: `${index}`,
        businessId: BUSINESS,
        status: "ACTIVE",
      });
      chat.userDirectory.set(`user-${index}`, {
        name: `M ${index}`,
        driverId: id,
      });
    }

    await expect(
      send.execute({
        userId: MANAGER,
        audience: "ALL_ACTIVE_WITH_APP",
        kind: "TEXT",
        body: "grande demais",
        broadcastKey: KEY,
      }),
    ).rejects.toMatchObject({ code: "CHAT_BROADCAST_TOO_LARGE" });

    expect(chat.messages).toHaveLength(0);
  });

  it("is not open to a driver token", async () => {
    const { send } = world();

    await expect(
      send.execute({
        userId: JOAO_USER,
        audience: "ALL_ACTIVE_WITH_APP",
        kind: "TEXT",
        body: "oi a todos",
        broadcastKey: KEY,
      }),
    ).rejects.toMatchObject({ code: "DRIVER_CHAT_OWN_THREAD" });
  });
});

describe("one recipient, one key", () => {
  it("uses the Idempotency-Key header as the message key when the body has none", async () => {
    const { chat, outbox, send } = world();

    const request = {
      userId: MANAGER,
      driverIds: [JOAO],
      kind: "TEXT" as const,
      body: "Aviso para um só",
      broadcastKey: KEY,
    };

    const first = await send.execute(request);
    const again = await send.execute(request);

    // Before: the dialog's key was dropped for a single driver, and the
    // retry wrote — and rang — a second message.
    expect(chat.messages).toHaveLength(1);
    expect(again.data[0].id).toBe(first.data[0].id);
    expect(again.outcomes[0].status).toBe("ALREADY_SENT");
    expect(outbox.published).toHaveLength(1);
  });

  it("answers the winner's message to the loser of a same-key race, never a 500", async () => {
    const { chat, outbox, send } = world();

    // Both requests pass the "already sent?" check before either inserts —
    // what two replicas receiving the same double click do.
    const lookup = chat.findMessageBySubmissionId.bind(chat);
    let arrived = 0;
    let release!: () => void;
    const bothChecked = new Promise<void>((done) => (release = done));

    chat.findMessageBySubmissionId = async (...args) => {
      const answer = await lookup(...args);

      arrived += 1;
      if (arrived === 2) release();

      await bothChecked;

      return answer;
    };

    const request = {
      userId: MANAGER,
      driverIds: [JOAO],
      kind: "TEXT" as const,
      body: "Clique duplo",
      clientSubmissionId: KEY,
    };

    const [one, two] = await Promise.all([
      send.execute(request),
      send.execute(request),
    ]);

    expect(chat.messages).toHaveLength(1);
    expect(one.data[0].id).toBe(two.data[0].id);
    expect([one.outcomes[0].status, two.outcomes[0].status].sort()).toEqual([
      "ALREADY_SENT",
      "SENT",
    ]);
    expect(outbox.published).toHaveLength(1);
  });
});

describe("a key another company already used", () => {
  it("answers 409 and writes nothing, saying nothing of that company's message", async () => {
    const { chat, outbox, send } = world();

    const mine = await send.execute({
      userId: MANAGER,
      driverIds: [JOAO],
      kind: "TEXT",
      body: "Mensagem da empresa A",
      clientSubmissionId: KEY,
    });

    // The column is unique across tenants: B's insert hits P2002, and B's
    // scoped lookup finds no winner of its own.
    const refusal = await send
      .execute({
        userId: FOREIGN_MANAGER,
        driverIds: [FOREIGN],
        kind: "TEXT",
        body: "Mensagem da empresa B",
        clientSubmissionId: KEY,
      })
      .then(
        () => null,
        (error: { statusCode: number; code: string; message: string }) => error,
      );

    expect(refusal).toMatchObject({
      statusCode: 409,
      code: "CHAT_SUBMISSION_CONFLICT",
    });
    expect(JSON.stringify(refusal)).not.toContain(mine.data[0].id);
    expect(refusal?.message).not.toContain("empresa A");

    expect(chat.messages.map((message) => message.body)).toEqual([
      "Mensagem da empresa A",
    ]);
    expect(outbox.published).toHaveLength(1);
  });
});

describe("chat recipients", () => {
  function listing() {
    const context = world();

    return {
      ...context,
      recipients: new ListChatRecipientsUseCase(context.users, context.chat),
    };
  }

  it("lists the company's active drivers alphabetically, with who has the app", async () => {
    const { recipients } = listing();

    const page = await recipients.execute({ userId: MANAGER, limit: 10 });

    expect(page.data.map(({ id, hasApp }) => [id, hasApp])).toEqual([
      [NO_APP, false],
      [REVOKED, false],
      // An account the login refuses (inactive branch) is not "the app".
      [BRANCH_OFF, false],
      [JOAO, true],
      [MARIA, true],
    ]);
    expect(page.audience).toEqual({ withApp: 2, withoutApp: 3 });

    // Only the fields of the choice (decision 4.7): no CNH.
    expect(Object.keys(page.data[0]).sort()).toEqual(["hasApp", "id", "name"]);
  });

  it("filters by the app line and by name only, and pages by cursor", async () => {
    const { recipients } = listing();

    const withApp = await recipients.execute({
      userId: MANAGER,
      limit: 10,
      app: "WITH_APP",
    });
    expect(withApp.data.map((row) => row.id)).toEqual([JOAO, MARIA]);

    const without = await recipients.execute({
      userId: MANAGER,
      limit: 10,
      app: "WITHOUT_APP",
    });
    expect(without.data.map((row) => row.id)).toEqual([
      NO_APP,
      REVOKED,
      BRANCH_OFF,
    ]);

    const byName = await recipients.execute({
      userId: MANAGER,
      limit: 10,
      search: "mar",
    });
    expect(byName.data.map((row) => row.id)).toEqual([MARIA]);

    // The CNH is registration data: no longer a search key here.
    const byCnh = await recipients.execute({
      userId: MANAGER,
      limit: 10,
      search: "cnh-mar",
    });
    expect(byCnh.data).toEqual([]);

    const first = await recipients.execute({ userId: MANAGER, limit: 4 });
    expect(first.hasMore).toBe(true);

    const second = await recipients.execute({
      userId: MANAGER,
      limit: 4,
      cursor: first.nextCursor!,
    });

    expect(second.data.map((row) => row.id)).toEqual([MARIA]);
    expect(second.hasMore).toBe(false);

    // The company-wide count comes with the first page only.
    expect(second.audience).toBeNull();
  });

  it("is refused to a driver token with PERMISSION_DENIED", async () => {
    const { recipients } = listing();

    await expect(
      recipients.execute({ userId: JOAO_USER, limit: 10 }),
    ).rejects.toMatchObject({ statusCode: 403, code: "PERMISSION_DENIED" });
  });

  it("answers a MASTER for the company selected, and only that one", async () => {
    const { recipients } = listing();

    const page = await recipients.execute({
      userId: MASTER,
      businessId: OTHER_BUSINESS,
      limit: 10,
    });

    expect(page.data.map((row) => row.id)).toEqual([FOREIGN]);
  });
});

describe("the in-memory thread list", () => {
  it("orders threads nobody wrote to newest first, like the SQL", async () => {
    const { chat } = world();

    const older = await chat.getOrCreateThread(BUSINESS, JOAO);
    older.created_at = new Date("2026-09-01T10:00:00Z");

    const newer = await chat.getOrCreateThread(BUSINESS, MARIA);
    newer.created_at = new Date("2026-09-02T10:00:00Z");

    const { data } = await chat.listThreads({
      businessId: BUSINESS,
      requesterUserId: MANAGER,
      page: 1,
      pageSize: 10,
    });

    expect(data.map((entry) => entry.id)).toEqual([newer.id, older.id]);
  });
});
