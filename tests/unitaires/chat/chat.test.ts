import { describe, expect, it, vi } from "vitest";

import { SendChatMessageUseCase } from "@/modules/chat/usecases/send-chat-message/send-chat-message-usecase";
import { ListChatThreadsUseCase } from "@/modules/chat/usecases/list-chat-threads/list-chat-threads-usecase";

import { ListChatMessagesUseCase } from "@/modules/chat/usecases/list-chat-messages/list-chat-messages-usecase";
import { MarkChatReadUseCase } from "@/modules/chat/usecases/mark-chat-read/mark-chat-read-usecase";
import { MarkChatDeliveredUseCase } from "@/modules/chat/usecases/mark-chat-delivered/mark-chat-delivered-usecase";
import { GetChatAttachmentUrlUseCase } from "@/modules/chat/usecases/get-chat-attachment-url/get-chat-attachment-url-usecase";
import { SearchChatMessagesUseCase } from "@/modules/chat/usecases/search-chat-messages/search-chat-messages-usecase";

import { InMemoryChatRepository } from "@/modules/chat/repositories/in-memory/in-memory-chat-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import { InMemoryDriverRepository } from "@/modules/driver/repositories/in-memory/in-memory-driver-repository";
import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";

import { renderChatMessagePush } from "@/shared/notifications/policies/chat-message-policy";
import { channelsForRecipient } from "@/shared/notifications/pipeline-rules";

import { sendChatDeliveredEvent, sendChatReadEvent } from "@/websocket";

import {
  ChatMessageNotFoundError,
  ChatDeliveryNotFoundError,
  ChatDeliveryReceiptNotAllowedError,
  ChatDriverNotFoundError,
  ChatThreadNotFoundError,
} from "@/modules/chat/usecases/errors/chat-errors";
import { AppError } from "@/shared/errors/AppError";

import type { UploadService } from "@/shared/services/upload-service";
import type { OutboxService } from "@/shared/notifications/outbox-service";

import type { User } from "@/modules/user/dtos/user-dto";
import type { Driver } from "@/modules/driver/dtos/driver-dto";

import type { CreateDeliveryProps } from "@/modules/delivery/dtos/delivery-dto";

const BUSINESS = "018f0000-0000-7000-8000-00000000000b";
const OTHER_BUSINESS = "018f0000-0000-7000-8000-00000000000c";

const MANAGER_ID = "018f0000-0000-7000-8000-0000000000a2";
const AGENT_ID = "018f0000-0000-7000-8000-0000000000a3";

// The software vendor's seat: belongs to no company, works over the one
// selected in the interface.
const MASTER_ID = "018f0000-0000-7000-8000-0000000000a5";

const JOAO_USER_ID = "018f0000-0000-7000-8000-0000000000a1";
const MARIA_USER_ID = "018f0000-0000-7000-8000-0000000000a4";

const JOAO_DRIVER_ID = "018f0000-0000-7000-8000-0000000000d1";
const MARIA_DRIVER_ID = "018f0000-0000-7000-8000-0000000000d2";
const FOREIGN_DRIVER_ID = "018f0000-0000-7000-8000-0000000000d3";
const NO_APP_DRIVER_ID = "018f0000-0000-7000-8000-0000000000d4";

const SUBMISSION = "018f0000-0000-7000-8000-00000000e001";

// The use case wraps message + outbox in one database transaction; against
// in-memory repositories the transaction is a plain passthrough.
vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({}),
  },
}));

// Socket emission is transport: recorded here, asserted where it matters.
vi.mock("@/websocket", () => ({
  sendChatMessageEvent: vi.fn(),
  sendChatReadEvent: vi.fn(),
  sendChatDeliveredEvent: vi.fn(),
  getOnlineUserIds: vi.fn(async () => []),
}));

// The presigned upload already happened; the stub answers as the bucket
// would for keys the business owns, and signs reads like local storage.
const uploadStub = {
  resolvePresignedUploads: async (files: Array<{ key: string }>) =>
    files.map(({ key }) => ({ path: key })),
  getFileUrl: async (key: string) => `http://storage.local/${key}`,
} as unknown as UploadService;

function makeOutboxRecorder() {
  const published: Array<{ topic: string; payload: Record<string, unknown> }> =
    [];

  const stub = {
    publish: async (
      _tx: unknown,
      event: { topic: string; payload: Record<string, unknown> },
    ) => {
      published.push(event);
    },
  } as unknown as OutboxService;

  return { stub, published };
}

function makeRepositories() {
  const userRepository = new InMemoryUserRepository();
  const driverRepository = new InMemoryDriverRepository();

  const deliveryRepository = new InMemoryDeliveryRepository();
  const chatRepository = new InMemoryChatRepository();

  const users: Array<Partial<User>> = [
    {
      id: MANAGER_ID,
      name: "Gestora Web",
      role: "BUSINESS_ADMIN",
      businessId: BUSINESS,
    },
    {
      id: AGENT_ID,
      name: "Atendente SAC",
      role: "BUSINESS_ADMIN",
      businessId: BUSINESS,
    },
    {
      id: MASTER_ID,
      name: "Suporte Trajetto",
      role: "MASTER",
      businessId: null,
    },
    {
      id: JOAO_USER_ID,
      name: "João Motorista",
      role: "BUSINESS_USER",
      businessId: BUSINESS,
      driverId: JOAO_DRIVER_ID,
    },
    {
      id: MARIA_USER_ID,
      name: "Maria Motorista",
      role: "BUSINESS_USER",
      businessId: BUSINESS,
      driverId: MARIA_DRIVER_ID,
    },
  ];

  users.forEach((user) => userRepository.user.push(user as User));

  // status is a required column: the send asks the login rule whether the
  // driver can read the thread, and that rule refuses a driver not ACTIVE.
  const drivers: Array<Partial<Driver>> = [
    { id: JOAO_DRIVER_ID, name: "João Motorista", cnh: "111", businessId: BUSINESS, status: "ACTIVE" },
    { id: MARIA_DRIVER_ID, name: "Maria Motorista", cnh: "222", businessId: BUSINESS, status: "ACTIVE" },
    { id: NO_APP_DRIVER_ID, name: "Sem Aplicativo", cnh: "444", businessId: BUSINESS, status: "ACTIVE" },
    { id: FOREIGN_DRIVER_ID, name: "De Outra Empresa", cnh: "333", businessId: OTHER_BUSINESS, status: "ACTIVE" },
  ];

  drivers.forEach((driver) => driverRepository.drivers.push(driver as Driver));

  // The chat repository resolves names through its own directories.
  users.forEach((user) =>
    chatRepository.userDirectory.set(user.id!, {
      name: user.name!,
      driverId: user.driverId ?? null,
    }),
  );

  chatRepository.driverDirectory.set(JOAO_DRIVER_ID, {
    name: "João Motorista",
    cnh: "111",
  });
  chatRepository.driverDirectory.set(MARIA_DRIVER_ID, {
    name: "Maria Motorista",
    cnh: "222",
  });

  return { userRepository, driverRepository, deliveryRepository, chatRepository };
}

type Repositories = ReturnType<typeof makeRepositories>;

function makeSendUseCase(repos: Repositories, outbox?: OutboxService) {
  return new SendChatMessageUseCase(
    repos.userRepository,
    repos.driverRepository,
    repos.deliveryRepository,
    repos.chatRepository,
    uploadStub,
    outbox ?? makeOutboxRecorder().stub,
  );
}

describe("send-chat-message", () => {
  it("creates thread and message, and pushes only towards the driver", async () => {
    const repos = makeRepositories();
    const outbox = makeOutboxRecorder();

    const { data } = await makeSendUseCase(repos, outbox.stub).execute({
      userId: MANAGER_ID,
      driverIds: [JOAO_DRIVER_ID],
      kind: "TEXT",
      body: "Cliente remarcou para depois das 14h.",
    });

    expect(data).toHaveLength(1);
    expect(repos.chatRepository.threads).toHaveLength(1);

    const thread = repos.chatRepository.threads[0];

    expect(thread.driverId).toBe(JOAO_DRIVER_ID);
    expect(thread.last_message_at).not.toBeNull();

    // SAC → driver rings the phone through the pipeline...
    expect(outbox.published).toHaveLength(1);
    expect(outbox.published[0].topic).toBe("chat-message.sent");
    expect(outbox.published[0].payload.recipientUserId).toBe(JOAO_USER_ID);

    // ...and the driver's answer rings nobody.
    const reply = await makeSendUseCase(repos, outbox.stub).execute({
      userId: JOAO_USER_ID,
      driverIds: [JOAO_DRIVER_ID],
      kind: "TEXT",
      body: "Certo, sigo para o próximo.",
    });

    expect(reply.data[0].threadId).toBe(thread.id);
    expect(outbox.published).toHaveLength(1);
  });

  it("is idempotent by client submission id", async () => {
    const repos = makeRepositories();
    const useCase = makeSendUseCase(repos);

    const first = await useCase.execute({
      userId: MANAGER_ID,
      driverIds: [JOAO_DRIVER_ID],
      kind: "TEXT",
      body: "Confirma a entrega?",
      clientSubmissionId: SUBMISSION,
    });

    const resend = await useCase.execute({
      userId: MANAGER_ID,
      driverIds: [JOAO_DRIVER_ID],
      kind: "TEXT",
      body: "Confirma a entrega?",
      clientSubmissionId: SUBMISSION,
    });

    expect(repos.chatRepository.messages).toHaveLength(1);
    expect(resend.data[0].id).toBe(first.data[0].id);
  });

  it("fans a mass notice out as one message per thread, sharing a broadcast id", async () => {
    const repos = makeRepositories();
    const outbox = makeOutboxRecorder();

    const { data } = await makeSendUseCase(repos, outbox.stub).execute({
      userId: MANAGER_ID,
      driverIds: [JOAO_DRIVER_ID, MARIA_DRIVER_ID],
      kind: "TEXT",
      body: "Balança na BR-101 hoje. Planejem a rota.",
    });

    expect(data).toHaveLength(2);
    expect(repos.chatRepository.threads).toHaveLength(2);

    const [first, second] = repos.chatRepository.messages;

    expect(first.broadcast_id).not.toBeNull();
    expect(first.broadcast_id).toBe(second.broadcast_id);

    // Each driver got their own push.
    expect(outbox.published).toHaveLength(2);
  });

  it("locks a driver token to their own conversation", async () => {
    const repos = makeRepositories();

    await expect(
      makeSendUseCase(repos).execute({
        userId: JOAO_USER_ID,
        driverIds: [MARIA_DRIVER_ID],
        kind: "TEXT",
        body: "oi",
      }),
    ).rejects.toMatchObject({ code: "DRIVER_CHAT_OWN_THREAD" });
  });

  it("refuses a driver of another company exactly like a missing one", async () => {
    const repos = makeRepositories();

    const foreign = makeSendUseCase(repos).execute({
      userId: MANAGER_ID,
      driverIds: [FOREIGN_DRIVER_ID],
      kind: "TEXT",
      body: "oi",
    });

    const missing = makeSendUseCase(repos).execute({
      userId: MANAGER_ID,
      driverIds: ["018f0000-0000-7000-8000-0000000000fe"],
      kind: "TEXT",
      body: "oi",
    });

    // It used to be 403 "não pertence à sua empresa" against 400 "não
    // encontrado": the difference said the id was real in another tenant.
    const answers = await Promise.all(
      [foreign, missing].map((attempt) =>
        attempt.then(
          () => null,
          (error: AppError) => ({
            type: error.constructor.name,
            statusCode: error.statusCode,
            code: error.code,
            message: error.message,
          }),
        ),
      ),
    );

    expect(answers[0]).toEqual({
      type: ChatDriverNotFoundError.name,
      statusCode: 404,
      code: "CHAT_DRIVER_NOT_FOUND",
      message: "Motorista não encontrado para esta conversa.",
    });
    expect(answers[1]).toEqual(answers[0]);
  });

  it("validates the delivery chip inside the sender's scope", async () => {
    const repos = makeRepositories();

    const mine = await repos.deliveryRepository.createDelivery({
      recipient_name: "Cliente A",
      city: "São Paulo",
      uf: "SP",
      street: "Rua Um",
      businessId: BUSINESS,
      shipperId: "018f0000-0000-7000-8000-0000000000f1",
    } as CreateDeliveryProps);

    mine.driverId = MARIA_DRIVER_ID;

    // João talking about Maria's delivery: not his, so "not found".
    await expect(
      makeSendUseCase(repos).execute({
        userId: JOAO_USER_ID,
        driverIds: [JOAO_DRIVER_ID],
        kind: "TEXT",
        body: "Sobre essa entrega...",
        deliveryId: mine.id!,
      }),
    ).rejects.toBeInstanceOf(ChatDeliveryNotFoundError);

    // The SAC references it freely — and the chip comes resolved.
    const sent = await makeSendUseCase(repos).execute({
      userId: MANAGER_ID,
      driverIds: [MARIA_DRIVER_ID],
      kind: "TEXT",
      body: "Sobre essa entrega...",
      deliveryId: mine.id!,
    });

    expect(sent.data[0].delivery?.recipient_name).toBe("Cliente A");
  });

  it("demands what each kind needs: text, attachment, duration — each with its code", async () => {
    // Red before: these went out as the fallback BAD_REQUEST, which the
    // clients cannot tell apart (decision 11.3: every refusal has its code).
    const repos = makeRepositories();
    const useCase = makeSendUseCase(repos);

    await expect(
      useCase.execute({
        userId: MANAGER_ID,
        driverIds: [JOAO_DRIVER_ID],
        kind: "TEXT",
        body: "   ",
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "CHAT_TEXT_REQUIRED" });

    await expect(
      useCase.execute({
        userId: MANAGER_ID,
        driverIds: [JOAO_DRIVER_ID],
        kind: "IMAGE",
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "CHAT_ATTACHMENT_REQUIRED" });

    await expect(
      useCase.execute({
        userId: JOAO_USER_ID,
        driverIds: [JOAO_DRIVER_ID],
        kind: "AUDIO",
        attachmentKey: `chatAttachments/${BUSINESS}/voz.m4a`,
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "CHAT_AUDIO_DURATION_REQUIRED" });

    await expect(
      useCase.execute({ userId: MANAGER_ID, driverIds: [], kind: "TEXT", body: "Oi" }),
    ).rejects.toMatchObject({ statusCode: 400, code: "CHAT_RECIPIENTS_REQUIRED" });

    await expect(
      useCase.execute({
        userId: MANAGER_ID,
        driverIds: [JOAO_DRIVER_ID, MARIA_DRIVER_ID],
        kind: "TEXT",
        body: "Aviso",
        clientSubmissionId: "018f0000-0000-7000-8000-0000000000c2",
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "CHAT_BROADCAST_REFERENCE_NOT_ALLOWED" });

    expect(repos.chatRepository.messages).toEqual([]);
  });

  it("signs the attachment URL on the way out", async () => {
    const repos = makeRepositories();

    const { data } = await makeSendUseCase(repos).execute({
      userId: JOAO_USER_ID,
      driverIds: [JOAO_DRIVER_ID],
      kind: "AUDIO",
      attachmentKey: `chatAttachments/${BUSINESS}/voz.m4a`,
      durationMs: 12_000,
    });

    expect(data[0].attachment_url).toBe(
      `http://storage.local/chatAttachments/${BUSINESS}/voz.m4a`,
    );
    expect(
      (data[0] as unknown as Record<string, unknown>).attachment_key,
    ).toBeUndefined();
  });
});

describe("threads, unread and read cursors", () => {
  async function seedConversation(repos: Repositories) {
    const send = makeSendUseCase(repos);

    await send.execute({
      userId: MANAGER_ID,
      driverIds: [JOAO_DRIVER_ID],
      kind: "TEXT",
      body: "Bom dia! Rota liberada.",
    });

    await send.execute({
      userId: JOAO_USER_ID,
      driverIds: [JOAO_DRIVER_ID],
      kind: "TEXT",
      body: "Bom dia, saindo agora.",
    });

    return repos.chatRepository.threads[0];
  }

  it("derives unread from the other side only, per requester", async () => {
    const repos = makeRepositories();
    await seedConversation(repos);

    const listThreads = new ListChatThreadsUseCase(
      repos.userRepository,
      repos.chatRepository,
    );

    // For the staff: only João's reply is unread.
    const forStaff = await listThreads.execute({
      userId: MANAGER_ID,
      page: 1,
      pageSize: 10,
    });

    expect(forStaff.total).toBe(1);
    expect(forStaff.data[0].unreadCount).toBe(1);
    expect(forStaff.totalUnread).toBe(1);

    // For João: only the staff's opener is unread.
    const forDriver = await listThreads.execute({
      userId: JOAO_USER_ID,
      page: 1,
      pageSize: 10,
    });

    expect(forDriver.data[0].unreadCount).toBe(1);
  });

  it("mark-read zeroes the counter and never rewinds", async () => {
    const repos = makeRepositories();
    const thread = await seedConversation(repos);

    const markRead = new MarkChatReadUseCase(
      repos.userRepository,
      repos.chatRepository,
    );

    await markRead.execute({ userId: MANAGER_ID, threadId: thread.id });

    const listThreads = new ListChatThreadsUseCase(
      repos.userRepository,
      repos.chatRepository,
    );

    const afterRead = await listThreads.execute({
      userId: MANAGER_ID,
      page: 1,
      pageSize: 10,
    });

    expect(afterRead.data[0].unreadCount).toBe(0);

    // A stale cursor arriving late cannot "unread" the thread.
    await repos.chatRepository.markThreadRead(
      thread.id,
      MANAGER_ID,
      new Date(Date.now() - 60_000),
    );

    const stillRead = await listThreads.execute({
      userId: MANAGER_ID,
      page: 1,
      pageSize: 10,
    });

    expect(stillRead.data[0].unreadCount).toBe(0);
  });

  it("refuses a foreign thread on mark-read", async () => {
    const repos = makeRepositories();
    const thread = await seedConversation(repos);

    const markRead = new MarkChatReadUseCase(
      repos.userRepository,
      repos.chatRepository,
    );

    // Maria's token cannot touch João's thread.
    await expect(
      markRead.execute({ userId: MARIA_USER_ID, threadId: thread.id }),
    ).rejects.toBeInstanceOf(ChatThreadNotFoundError);
  });
});

describe("delivery cursor (grey double check)", () => {
  async function seedThreadWithMessage(repos: Repositories) {
    await makeSendUseCase(repos).execute({
      userId: MANAGER_ID,
      driverIds: [JOAO_DRIVER_ID],
      kind: "TEXT",
      body: "Passe na doca 3 ao chegar.",
    });

    return repos.chatRepository.threads[0];
  }

  function makeMarkDelivered(repos: Repositories) {
    return new MarkChatDeliveredUseCase(
      repos.userRepository,
      repos.chatRepository,
    );
  }

  it("advances the driver's cursor and tells the SAC", async () => {
    const repos = makeRepositories();
    const thread = await seedThreadWithMessage(repos);

    vi.mocked(sendChatDeliveredEvent).mockClear();

    const markDelivered = makeMarkDelivered(repos);

    const first = new Date(Date.now() - 120_000);
    const second = new Date(Date.now() - 60_000);

    await markDelivered.execute({
      userId: JOAO_USER_ID,
      threadId: thread.id,
      deliveredAt: first,
    });

    expect(thread.driver_delivered_at?.getTime()).toBe(first.getTime());

    const answer = await markDelivered.execute({
      userId: JOAO_USER_ID,
      threadId: thread.id,
      deliveredAt: second,
    });

    expect(thread.driver_delivered_at?.getTime()).toBe(second.getTime());
    expect(answer.delivered_at.getTime()).toBe(second.getTime());

    // The receipt reaches the SAC room only — carried by the emitter, which
    // never hands it to the driver's own room.
    expect(sendChatDeliveredEvent).toHaveBeenCalledTimes(2);
    expect(sendChatDeliveredEvent).toHaveBeenLastCalledWith(BUSINESS, {
      threadId: thread.id,
      side: "DRIVER",
      driverUserId: JOAO_USER_ID,
      delivered_at: second.toISOString(),
    });
  });

  it("never rewinds on an out-of-order receipt", async () => {
    const repos = makeRepositories();
    const thread = await seedThreadWithMessage(repos);

    const markDelivered = makeMarkDelivered(repos);

    const recent = new Date(Date.now() - 30_000);
    const stale = new Date(Date.now() - 300_000);

    await markDelivered.execute({
      userId: JOAO_USER_ID,
      threadId: thread.id,
      deliveredAt: recent,
    });

    // A retry of an older receipt, or two crossing on the wire, cannot
    // undeliver what the device already holds.
    await markDelivered.execute({
      userId: JOAO_USER_ID,
      threadId: thread.id,
      deliveredAt: stale,
    });

    expect(thread.driver_delivered_at?.getTime()).toBe(recent.getTime());
  });

  it("advances the staff cursor for an agent, never the driver's", async () => {
    const repos = makeRepositories();
    const thread = await seedThreadWithMessage(repos);

    const { side } = await makeMarkDelivered(repos).execute({
      userId: MANAGER_ID,
      threadId: thread.id,
    });

    // The side comes from the token, never from the payload: an agent's
    // panel confirms for the base, and cannot speak for the phone.
    expect(side).toBe("STAFF");
    expect(thread.staff_delivered_at).not.toBeNull();
    expect(thread.driver_delivered_at).toBeNull();
  });

  it("takes the most advanced confirmation of the whole SAC team", async () => {
    const repos = makeRepositories();
    const thread = await seedThreadWithMessage(repos);

    const early = new Date(Date.now() - 120_000);
    const late = new Date(Date.now() - 30_000);

    await makeMarkDelivered(repos).execute({
      userId: AGENT_ID,
      threadId: thread.id,
      deliveredAt: late,
    });

    // A colleague whose panel is behind must not undeliver what another
    // panel already holds — "the base has it" is true of the team.
    await makeMarkDelivered(repos).execute({
      userId: MANAGER_ID,
      threadId: thread.id,
      deliveredAt: early,
    });

    expect(thread.staff_delivered_at?.getTime()).toBe(late.getTime());
  });

  it("refuses a receipt from a MASTER", async () => {
    const repos = makeRepositories();
    const thread = await seedThreadWithMessage(repos);

    // The vendor's panel holding the message is not the customer's
    // operation holding it — the same reason a master cannot write or
    // advance the read cursor.
    await expect(
      makeMarkDelivered(repos).execute({
        userId: MASTER_ID,
        threadId: thread.id,
        businessId: thread.businessId,
      }),
    ).rejects.toBeInstanceOf(ChatDeliveryReceiptNotAllowedError);

    expect(thread.staff_delivered_at).toBeNull();
    expect(thread.driver_delivered_at).toBeNull();
  });

  it("refuses a thread of another company", async () => {
    const repos = makeRepositories();
    await seedThreadWithMessage(repos);

    const foreignThread = await repos.chatRepository.getOrCreateThread(
      OTHER_BUSINESS,
      FOREIGN_DRIVER_ID,
    );

    await expect(
      makeMarkDelivered(repos).execute({
        userId: JOAO_USER_ID,
        threadId: foreignThread.id,
      }),
    ).rejects.toBeInstanceOf(ChatThreadNotFoundError);
  });

  it("clamps a phone clock running ahead to the server's now", async () => {
    const repos = makeRepositories();
    const thread = await seedThreadWithMessage(repos);

    const future = new Date(Date.now() + 3_600_000);

    const before = Date.now();

    const { delivered_at } = await makeMarkDelivered(repos).execute({
      userId: JOAO_USER_ID,
      threadId: thread.id,
      deliveredAt: future,
    });

    const after = Date.now();

    // An hour-ahead clock would otherwise mark as delivered messages that
    // do not exist yet — and the cursor never rewinds.
    expect(delivered_at.getTime()).toBeLessThan(future.getTime());
    expect(delivered_at.getTime()).toBeGreaterThanOrEqual(before);
    expect(delivered_at.getTime()).toBeLessThanOrEqual(after);
    expect(thread.driver_delivered_at?.getTime()).toBe(delivered_at.getTime());
  });

  it("shows each side the OTHER side's delivery cursor", async () => {
    const repos = makeRepositories();
    const thread = await seedThreadWithMessage(repos);

    const listMessages = new ListChatMessagesUseCase(
      repos.userRepository,
      repos.chatRepository,
      uploadStub,
      repos.driverRepository,
    );

    const beforeReceipt = await listMessages.execute({
      userId: MANAGER_ID,
      threadId: thread.id,
      limit: 30,
    });

    expect(beforeReceipt.counterpartDeliveredAt).toBeNull();

    const { delivered_at } = await makeMarkDelivered(repos).execute({
      userId: JOAO_USER_ID,
      threadId: thread.id,
    });

    const forStaff = await listMessages.execute({
      userId: MANAGER_ID,
      threadId: thread.id,
      limit: 30,
    });

    expect(forStaff.counterpartDeliveredAt?.getTime()).toBe(
      delivered_at.getTime(),
    );

    // The driver's own cursor is not news to the driver: until an agent's
    // panel confirms, there is nothing to show on that side.
    const forDriverBefore = await listMessages.execute({
      userId: JOAO_USER_ID,
      threadId: thread.id,
      limit: 30,
    });

    expect(forDriverBefore.counterpartDeliveredAt).toBeNull();

    const staffReceipt = await makeMarkDelivered(repos).execute({
      userId: MANAGER_ID,
      threadId: thread.id,
    });

    const forDriver = await listMessages.execute({
      userId: JOAO_USER_ID,
      threadId: thread.id,
      limit: 30,
    });

    expect(forDriver.counterpartDeliveredAt?.getTime()).toBe(
      staffReceipt.delivered_at.getTime(),
    );

    // And the staff cursor never leaks into the staff's own view.
    const forStaffAgain = await listMessages.execute({
      userId: MANAGER_ID,
      threadId: thread.id,
      limit: 30,
    });

    expect(forStaffAgain.counterpartDeliveredAt?.getTime()).toBe(
      delivered_at.getTime(),
    );
  });
});

describe("how far the reader actually got", () => {
  function makeMarkRead(repos: Repositories) {
    return new MarkChatReadUseCase(repos.userRepository, repos.chatRepository);
  }

  async function seedThread(repos: Repositories) {
    await makeSendUseCase(repos).execute({
      userId: JOAO_USER_ID,
      driverIds: [JOAO_DRIVER_ID],
      kind: "TEXT",
      body: "Cheguei no endereço.",
    });

    return repos.chatRepository.threads[0];
  }

  it("stamps the instant the reader reports, not the server clock", async () => {
    const repos = makeRepositories();
    const thread = await seedThread(repos);

    const onScreen = new Date(Date.now() - 300_000);

    const { last_read_at } = await makeMarkRead(repos).execute({
      userId: MANAGER_ID,
      threadId: thread.id,
      readAt: onScreen,
    });

    // A panel parked on an old search hit discards live arrivals. Stamping
    // "now" from there would tell the driver his newest message was seen
    // when nobody saw it.
    expect(last_read_at.getTime()).toBe(onScreen.getTime());
  });

  it("clamps a reader clock running ahead", async () => {
    const repos = makeRepositories();
    const thread = await seedThread(repos);

    const before = Date.now();

    const { last_read_at } = await makeMarkRead(repos).execute({
      userId: MANAGER_ID,
      threadId: thread.id,
      readAt: new Date(Date.now() + 3_600_000),
    });

    expect(last_read_at.getTime()).toBeLessThanOrEqual(Date.now());
    expect(last_read_at.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("still cannot rewind a cursor that is already ahead", async () => {
    const repos = makeRepositories();
    const thread = await seedThread(repos);

    const markRead = makeMarkRead(repos);

    const recent = new Date(Date.now() - 10_000);
    const stale = new Date(Date.now() - 600_000);

    await markRead.execute({
      userId: MANAGER_ID,
      threadId: thread.id,
      readAt: recent,
    });

    await markRead.execute({
      userId: MANAGER_ID,
      threadId: thread.id,
      readAt: stale,
    });

    const stored = repos.chatRepository.reads.find(
      (row) => row.threadId === thread.id && row.userId === MANAGER_ID,
    );

    expect(stored?.last_read_at.getTime()).toBe(recent.getTime());
  });

  it("falls back to now when the reader says nothing", async () => {
    const repos = makeRepositories();
    const thread = await seedThread(repos);

    const before = Date.now();

    const { last_read_at } = await makeMarkRead(repos).execute({
      userId: MANAGER_ID,
      threadId: thread.id,
    });

    expect(last_read_at.getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe("jumping to a message", () => {
  function makeListMessages(repos: Repositories) {
    return new ListChatMessagesUseCase(
      repos.userRepository,
      repos.chatRepository,
      uploadStub,
      repos.driverRepository,
    );
  }

  /** Ten messages a minute apart, oldest first, so order is deterministic. */
  async function seedHistory(repos: Repositories) {
    await makeSendUseCase(repos).execute({
      userId: MANAGER_ID,
      driverIds: [JOAO_DRIVER_ID],
      kind: "TEXT",
      body: "primeira",
    });

    const thread = repos.chatRepository.threads[0];
    const base = new Date("2026-09-01T12:00:00.000Z");

    repos.chatRepository.messages = [];

    for (let i = 0; i < 10; i += 1) {
      repos.chatRepository.messages.push({
        id: `018f0000-0000-7000-8000-0000000000${String(i).padStart(2, "0")}`,
        threadId: thread.id,
        senderId: MANAGER_ID,
        kind: "TEXT",
        body: `mensagem ${i}`,
        attachment_key: null,
        duration_ms: null,
        deliveryId: null,
        broadcast_id: null,
        client_submission_id: null,
        created_at: new Date(base.getTime() + i * 60_000),
      } as (typeof repos.chatRepository.messages)[number]);
    }

    return thread;
  }

  it("centres the page on the message instead of on the end of the thread", async () => {
    const repos = makeRepositories();
    const thread = await seedHistory(repos);

    // Message 2 of ten: paging backwards to reach it from the end would be
    // several round trips and a pile of history nobody asked for.
    const page = await makeListMessages(repos).execute({
      userId: MANAGER_ID,
      threadId: thread.id,
      aroundMessageId: repos.chatRepository.messages[2].id,
      limit: 4,
    });

    const bodies = page.data.map((message) => message.body);

    // Newest first, like every other page — the anchor with its neighbours
    // on both sides.
    expect(bodies).toEqual([
      "mensagem 4",
      "mensagem 3",
      "mensagem 2",
      "mensagem 1",
    ]);
  });

  it("says there is newer history, and how to walk to it", async () => {
    const repos = makeRepositories();
    const thread = await seedHistory(repos);

    const page = await makeListMessages(repos).execute({
      userId: MANAGER_ID,
      threadId: thread.id,
      aroundMessageId: repos.chatRepository.messages[2].id,
      limit: 4,
    });

    // A thread that silently stops short of its newest message is how a
    // dispatcher misses a reply, so the window has to admit what it hid.
    expect(page.hasNewer).toBe(true);

    // Both cursors are EXCLUSIVE and point at the edges of what came back,
    // not at the edges of the thread: the next backward page starts before
    // the oldest row here, the next forward page after the newest.
    expect(page.previousCursor?.id).toBe(repos.chatRepository.messages[4].id);
    expect(page.nextCursor?.id).toBe(repos.chatRepository.messages[1].id);
  });

  it("walks forward from a cursor, newest last", async () => {
    const repos = makeRepositories();
    const thread = await seedHistory(repos);

    const forward = await makeListMessages(repos).execute({
      userId: MANAGER_ID,
      threadId: thread.id,
      after: {
        created_at: repos.chatRepository.messages[6].created_at,
        id: repos.chatRepository.messages[6].id,
      },
      limit: 2,
    });

    expect(forward.data.map((message) => message.body)).toEqual([
      "mensagem 8",
      "mensagem 7",
    ]);

    expect(forward.hasNewer).toBe(true);
  });

  it("has nothing newer when the page comes from the end of the thread", async () => {
    const repos = makeRepositories();
    const thread = await seedHistory(repos);

    const tail = await makeListMessages(repos).execute({
      userId: MANAGER_ID,
      threadId: thread.id,
      limit: 3,
    });

    expect(tail.data[0].body).toBe("mensagem 9");
    expect(tail.hasNewer).toBe(false);
    expect(tail.previousCursor).toBeNull();
  });

  it("refuses to centre on a message of another conversation", async () => {
    const repos = makeRepositories();
    const thread = await seedHistory(repos);

    const foreign = await repos.chatRepository.getOrCreateThread(
      BUSINESS,
      MARIA_DRIVER_ID,
    );

    repos.chatRepository.messages.push({
      ...repos.chatRepository.messages[0],
      id: "018f0000-0000-7000-8000-0000000000fe",
      threadId: foreign.id,
    });

    // The anchor is resolved on the server precisely so it can be checked
    // against the thread being read.
    await expect(
      makeListMessages(repos).execute({
        userId: MANAGER_ID,
        threadId: thread.id,
        aroundMessageId: "018f0000-0000-7000-8000-0000000000fe",
        limit: 4,
      }),
    ).rejects.toBeInstanceOf(ChatMessageNotFoundError);
  });
});

describe("get-chat-attachment-url", () => {
  function makeUseCase(repos: Repositories) {
    return new GetChatAttachmentUrlUseCase(
      repos.userRepository,
      repos.chatRepository,
      uploadStub,
    );
  }

  async function seedPhoto(repos: Repositories) {
    await makeSendUseCase(repos).execute({
      userId: MANAGER_ID,
      driverIds: [JOAO_DRIVER_ID],
      kind: "IMAGE",
      attachmentKey: `chatAttachments/${BUSINESS}/canhoto.jpg`,
    });

    return repos.chatRepository.messages[0];
  }

  it("re-signs one attachment without disturbing anything else", async () => {
    const repos = makeRepositories();
    const photo = await seedPhoto(repos);

    const { attachment_url } = await makeUseCase(repos).execute({
      userId: MANAGER_ID,
      messageId: photo.id,
    });

    // The whole point: a retry needs a fresh link for ONE photo. Reloading
    // the conversation to get it is what closed the viewer on top of the
    // driver, because the message list came back as the newest page only.
    expect(attachment_url).toContain("canhoto.jpg");
    expect(repos.chatRepository.messages).toHaveLength(1);
  });

  it("answers null for a message that carries no file", async () => {
    const repos = makeRepositories();

    await makeSendUseCase(repos).execute({
      userId: MANAGER_ID,
      driverIds: [JOAO_DRIVER_ID],
      kind: "TEXT",
      body: "Passe na doca 3 ao chegar.",
    });

    const text = repos.chatRepository.messages[0];

    // Asking is legitimate; the answer is simply that there is no file.
    const { attachment_url } = await makeUseCase(repos).execute({
      userId: MANAGER_ID,
      messageId: text.id,
    });

    expect(attachment_url).toBeNull();
  });

  it("refuses a message id that does not exist", async () => {
    const repos = makeRepositories();

    await expect(
      makeUseCase(repos).execute({
        userId: MANAGER_ID,
        messageId: "018f0000-0000-7000-8000-0000000000ff",
      }),
    ).rejects.toBeInstanceOf(ChatMessageNotFoundError);
  });

  it("does not hand a driver another driver's attachment", async () => {
    const repos = makeRepositories();
    const photo = await seedPhoto(repos);

    // The photo belongs to João's thread; Maria's token must not re-sign it,
    // and the answer is the one a random id gets — not "conversa não
    // encontrada", which confirmed the message existed.
    await expect(
      makeUseCase(repos).execute({
        userId: MARIA_USER_ID,
        messageId: photo.id,
      }),
    ).rejects.toMatchObject({
      name: "ChatMessageNotFoundError",
      statusCode: 404,
      code: "CHAT_MESSAGE_NOT_FOUND",
    });
  });
});

describe("list-chat-messages", () => {
  it("opens a conversation by driverId, with its history", async () => {
    const repos = makeRepositories();
    await makeSendUseCase(repos).execute({
      userId: MANAGER_ID,
      driverIds: [JOAO_DRIVER_ID],
      kind: "TEXT",
      body: "Passe na doca 3 ao chegar.",
    });

    const thread = repos.chatRepository.threads[0];

    const listMessages = new ListChatMessagesUseCase(
      repos.userRepository,
      repos.chatRepository,
      uploadStub,
      repos.driverRepository,
    );

    // The panel used to need the thread id, and got it from a thread list
    // that is paginated AND filtered by the search box. Opening a driver from
    // a message-text hit therefore showed an empty chat over a real history.
    const byDriver = await listMessages.execute({
      userId: MANAGER_ID,
      driverId: JOAO_DRIVER_ID,
      limit: 30,
    });

    expect(byDriver.threadId).toBe(thread.id);
    expect(byDriver.data.length).toBeGreaterThan(0);
    expect(byDriver.driverUser?.id).toBe(JOAO_USER_ID);
  });

  it("answers an empty chat — not an error — for a driver never written to", async () => {
    const repos = makeRepositories();

    const listMessages = new ListChatMessagesUseCase(
      repos.userRepository,
      repos.chatRepository,
      uploadStub,
      repos.driverRepository,
    );

    const fresh = await listMessages.execute({
      userId: MANAGER_ID,
      driverId: MARIA_DRIVER_ID,
      limit: 30,
    });

    // "Say hello, this conversation starts now" is the truth here, and only
    // here — the driver has an account, there is simply nothing said yet.
    expect(fresh.threadId).toBeNull();
    expect(fresh.data).toHaveLength(0);
    expect(fresh.driverUser?.id).toBe(MARIA_USER_ID);
  });

  it("reports no app account only when the driver really has none", async () => {
    const repos = makeRepositories();

    const listMessages = new ListChatMessagesUseCase(
      repos.userRepository,
      repos.chatRepository,
      uploadStub,
      repos.driverRepository,
    );

    const noApp = await listMessages.execute({
      userId: MANAGER_ID,
      driverId: NO_APP_DRIVER_ID,
      limit: 30,
    });

    expect(noApp.driverUser).toBeNull();
  });

  it("does not leak a driver of another company", async () => {
    const repos = makeRepositories();

    const listMessages = new ListChatMessagesUseCase(
      repos.userRepository,
      repos.chatRepository,
      uploadStub,
      repos.driverRepository,
    );

    const foreign = await listMessages.execute({
      userId: MANAGER_ID,
      driverId: FOREIGN_DRIVER_ID,
      limit: 30,
    });

    // Out of scope has to read exactly like a driver with no app access —
    // any other answer tells the caller that driver exists elsewhere.
    expect(foreign.threadId).toBeNull();
    expect(foreign.data).toHaveLength(0);
    expect(foreign.driverUser).toBeNull();
  });

  it("ignores a driverId sent with a driver token", async () => {
    const repos = makeRepositories();
    await makeSendUseCase(repos).execute({
      userId: MANAGER_ID,
      driverIds: [JOAO_DRIVER_ID],
      kind: "TEXT",
      body: "Passe na doca 3 ao chegar.",
    });

    const thread = repos.chatRepository.threads[0];

    const listMessages = new ListChatMessagesUseCase(
      repos.userRepository,
      repos.chatRepository,
      uploadStub,
      repos.driverRepository,
    );

    // The token decides whose conversation this is; a query string never can.
    const asDriver = await listMessages.execute({
      userId: JOAO_USER_ID,
      driverId: MARIA_DRIVER_ID,
      limit: 30,
    });

    expect(asDriver.threadId).toBe(thread.id);
  });

  it("resolves the driver's own thread from the token — even before it exists", async () => {
    const repos = makeRepositories();

    const listMessages = new ListChatMessagesUseCase(
      repos.userRepository,
      repos.chatRepository,
      uploadStub,
      repos.driverRepository,
    );

    // No conversation yet: an empty, valid chat.
    const empty = await listMessages.execute({
      userId: JOAO_USER_ID,
      limit: 30,
    });

    expect(empty.threadId).toBeNull();
    expect(empty.data).toHaveLength(0);

    await makeSendUseCase(repos).execute({
      userId: MANAGER_ID,
      driverIds: [JOAO_DRIVER_ID],
      kind: "TEXT",
      body: "Primeiro contato",
    });

    const opened = await listMessages.execute({
      userId: JOAO_USER_ID,
      limit: 30,
    });

    expect(opened.threadId).toBe(repos.chatRepository.threads[0].id);
    expect(opened.data[0].body).toBe("Primeiro contato");
  });

  it("paginates by cursor, newest first", async () => {
    const repos = makeRepositories();

    const thread = await repos.chatRepository.getOrCreateThread(
      BUSINESS,
      JOAO_DRIVER_ID,
    );

    const base = Date.now() - 60_000;

    for (let index = 0; index < 5; index++) {
      const message = await repos.chatRepository.createMessage({
        threadId: thread.id,
        senderId: MANAGER_ID,
        kind: "TEXT",
        body: `mensagem ${index}`,
        attachment_key: null,
        duration_ms: null,
        deliveryId: null,
        broadcast_id: null,
        client_submission_id: null,
      });

      // Deterministic spacing: cursor maths must not depend on the clock.
      message.created_at = new Date(base + index * 1000);
    }

    const listMessages = new ListChatMessagesUseCase(
      repos.userRepository,
      repos.chatRepository,
      uploadStub,
      repos.driverRepository,
    );

    const firstPage = await listMessages.execute({
      userId: MANAGER_ID,
      threadId: thread.id,
      limit: 2,
    });

    expect(firstPage.data.map((message) => message.body)).toEqual([
      "mensagem 4",
      "mensagem 3",
    ]);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = await listMessages.execute({
      userId: MANAGER_ID,
      threadId: thread.id,
      limit: 2,
      before: {
        created_at: new Date(firstPage.nextCursor!.created_at),
        id: firstPage.nextCursor!.id,
      },
    });

    expect(secondPage.data.map((message) => message.body)).toEqual([
      "mensagem 2",
      "mensagem 1",
    ]);
  });

  it("tells each side how far the other has read", async () => {
    const repos = makeRepositories();

    await makeSendUseCase(repos).execute({
      userId: MANAGER_ID,
      driverIds: [JOAO_DRIVER_ID],
      kind: "TEXT",
      body: "Chegou aí?",
    });

    const thread = repos.chatRepository.threads[0];
    const listMessages = new ListChatMessagesUseCase(
      repos.userRepository,
      repos.chatRepository,
      uploadStub,
      repos.driverRepository,
    );

    // Nobody read anything yet.
    const beforeRead = await listMessages.execute({
      userId: MANAGER_ID,
      threadId: thread.id,
      limit: 10,
    });

    expect(beforeRead.counterpartLastReadAt).toBeNull();

    // João reads: the staff's view of the counterpart cursor advances.
    await new MarkChatReadUseCase(
      repos.userRepository,
      repos.chatRepository,
    ).execute({ userId: JOAO_USER_ID, threadId: thread.id });

    const afterRead = await listMessages.execute({
      userId: MANAGER_ID,
      threadId: thread.id,
      limit: 10,
    });

    expect(afterRead.counterpartLastReadAt).not.toBeNull();

    // For João, the counterpart is the team: any agent's cursor counts.
    const forDriver = await listMessages.execute({
      userId: JOAO_USER_ID,
      limit: 10,
    });

    expect(forDriver.counterpartLastReadAt).toBeNull();

    await new MarkChatReadUseCase(
      repos.userRepository,
      repos.chatRepository,
    ).execute({ userId: AGENT_ID, threadId: thread.id });

    const forDriverAfter = await listMessages.execute({
      userId: JOAO_USER_ID,
      limit: 10,
    });

    expect(forDriverAfter.counterpartLastReadAt).not.toBeNull();
  });

  it("answers not-found for a thread of another company", async () => {
    const repos = makeRepositories();

    const foreignThread = await repos.chatRepository.getOrCreateThread(
      OTHER_BUSINESS,
      FOREIGN_DRIVER_ID,
    );

    const listMessages = new ListChatMessagesUseCase(
      repos.userRepository,
      repos.chatRepository,
      uploadStub,
      repos.driverRepository,
    );

    await expect(
      listMessages.execute({
        userId: MANAGER_ID,
        threadId: foreignThread.id,
        limit: 10,
      }),
    ).rejects.toBeInstanceOf(ChatThreadNotFoundError);
  });
});

describe("search-chat-messages", () => {
  it("searches every thread for the SAC, only their own for a driver", async () => {
    const repos = makeRepositories();
    const send = makeSendUseCase(repos);

    await send.execute({
      userId: JOAO_USER_ID,
      driverIds: [JOAO_DRIVER_ID],
      kind: "TEXT",
      body: "Cliente pediu reagendamento para sexta.",
    });

    await send.execute({
      userId: MANAGER_ID,
      driverIds: [MARIA_DRIVER_ID],
      kind: "TEXT",
      body: "Maria, reagendamento confirmado.",
    });

    const search = new SearchChatMessagesUseCase(
      repos.userRepository,
      repos.chatRepository,
      uploadStub,
    );

    const forStaff = await search.execute({
      userId: MANAGER_ID,
      search: "reagendamento",
      limit: 10,
    });

    expect(forStaff.data).toHaveLength(2);
    expect(
      forStaff.data.map((hit) => hit.driver.name).sort(),
    ).toEqual(["João Motorista", "Maria Motorista"]);

    const forDriver = await search.execute({
      userId: JOAO_USER_ID,
      search: "reagendamento",
      limit: 10,
    });

    expect(forDriver.data).toHaveLength(1);
    expect(forDriver.data[0].driver.id).toBe(JOAO_DRIVER_ID);
  });
});

describe("chat push policy", () => {
  it("renders the tray line per kind", () => {
    const base = {
      messageId: "m1",
      threadId: "t1",
      businessId: BUSINESS,
      recipientUserId: JOAO_USER_ID,
      senderName: "Gestora Web",
    };

    expect(
      renderChatMessagePush({ ...base, kind: "TEXT", bodyPreview: "Chegou aí?" }),
    ).toMatchObject({ title: "💬 Gestora Web", body: "Chegou aí?" });

    expect(
      renderChatMessagePush({ ...base, kind: "AUDIO", bodyPreview: null }).body,
    ).toBe("🎤 Mensagem de voz");

    expect(
      renderChatMessagePush({ ...base, kind: "IMAGE", bodyPreview: null }).body,
    ).toBe("📷 Foto");

    // Tapping opens the conversation, not the notifications feed.
    expect(
      renderChatMessagePush({ ...base, kind: "TEXT", bodyPreview: "x" }).data,
    ).toEqual({ url: "/chat" });
  });

  it("standalone push exists only with a device, and without an in-app row", () => {
    const flags = {
      activityNotificationsEnabled: false,
      emailNotificationsEnabled: false,
      whatsappNotificationsEnabled: false,
      hasWhatsAppPhone: false,
    };

    // Mandatory chat topic + device: push, and push alone.
    expect(
      channelsForRecipient(flags, {
        hasInAppContent: false,
        hasEmailContent: false,
        hasWhatsAppContent: false,
        isMandatory: true,
        hasPushDevice: true,
        hasStandalonePushContent: true,
      }),
    ).toEqual(["PUSH"]);

    // No device, no push row — web-only users accumulate nothing.
    expect(
      channelsForRecipient(flags, {
        hasInAppContent: false,
        hasEmailContent: false,
        hasWhatsAppContent: false,
        isMandatory: true,
        hasPushDevice: false,
        hasStandalonePushContent: true,
      }),
    ).toEqual([]);

    // Not mandatory and in-app muted: the user's silence wins.
    expect(
      channelsForRecipient(flags, {
        hasInAppContent: false,
        hasEmailContent: false,
        hasWhatsAppContent: false,
        isMandatory: false,
        hasPushDevice: true,
        hasStandalonePushContent: true,
      }),
    ).toEqual([]);
  });
});

describe("master is read-only in the chat", () => {
  async function seedThread(repos: Repositories) {
    await makeSendUseCase(repos).execute({
      userId: MANAGER_ID,
      driverIds: [JOAO_DRIVER_ID],
      kind: "TEXT",
      body: "Bom dia! Rota liberada.",
    });

    return repos.chatRepository.threads[0];
  }

  it("refuses a master message before anything is written", async () => {
    const repos = makeRepositories();
    const outbox = makeOutboxRecorder();

    await expect(
      makeSendUseCase(repos, outbox.stub).execute({
        userId: MASTER_ID,
        driverIds: [JOAO_DRIVER_ID],
        kind: "TEXT",
        body: "Aqui é o suporte da Trajetto.",
        businessId: BUSINESS,
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "MASTER_CHAT_READ_ONLY",
    });

    // No thread, no message, no push: the driver never hears from the vendor.
    expect(repos.chatRepository.threads).toHaveLength(0);
    expect(repos.chatRepository.messages).toHaveLength(0);
    expect(outbox.published).toHaveLength(0);
  });

  it("keeps the company's own staff writing", async () => {
    const repos = makeRepositories();

    const { data } = await makeSendUseCase(repos).execute({
      userId: AGENT_ID,
      driverIds: [JOAO_DRIVER_ID],
      kind: "TEXT",
      body: "Passando pra confirmar o endereço.",
    });

    expect(data).toHaveLength(1);
    expect(repos.chatRepository.messages).toHaveLength(1);
  });

  it("does not let a master advance the cursor nor emit chatRead", async () => {
    const repos = makeRepositories();
    const thread = await seedThread(repos);

    const markRead = new MarkChatReadUseCase(
      repos.userRepository,
      repos.chatRepository,
    );

    vi.mocked(sendChatReadEvent).mockClear();

    // The call succeeds — the interface marks a thread read on open, and an
    // error there would be a toast with no cause.
    const answer = await markRead.execute({
      userId: MASTER_ID,
      threadId: thread.id,
      businessId: BUSINESS,
    });

    expect(answer.last_read_at).toBeInstanceOf(Date);

    // ...but nothing was stored and the driver was told nothing: a double
    // check has to mean the company read it.
    expect(repos.chatRepository.reads).toHaveLength(0);
    expect(sendChatReadEvent).not.toHaveBeenCalled();

    // The same call from the company's own staff does move the cursor.
    await markRead.execute({ userId: MANAGER_ID, threadId: thread.id });

    expect(repos.chatRepository.reads).toHaveLength(1);
    expect(sendChatReadEvent).toHaveBeenCalledTimes(1);
  });

  it("still refuses a foreign thread to a master before the no-op", async () => {
    const repos = makeRepositories();
    await seedThread(repos);

    const markRead = new MarkChatReadUseCase(
      repos.userRepository,
      repos.chatRepository,
    );

    const foreignThread = await repos.chatRepository.getOrCreateThread(
      OTHER_BUSINESS,
      FOREIGN_DRIVER_ID,
    );

    await expect(
      markRead.execute({
        userId: MASTER_ID,
        threadId: foreignThread.id,
        businessId: BUSINESS,
      }),
    ).rejects.toBeInstanceOf(ChatThreadNotFoundError);
  });

  it("keeps reading open to the master on the selected company", async () => {
    const repos = makeRepositories();
    const thread = await seedThread(repos);

    const threads = await new ListChatThreadsUseCase(
      repos.userRepository,
      repos.chatRepository,
    ).execute({
      userId: MASTER_ID,
      page: 1,
      pageSize: 10,
      businessId: BUSINESS,
    });

    expect(threads.total).toBe(1);

    const messages = await new ListChatMessagesUseCase(
      repos.userRepository,
      repos.chatRepository,
      uploadStub,
      repos.driverRepository,
    ).execute({
      userId: MASTER_ID,
      threadId: thread.id,
      limit: 10,
      businessId: BUSINESS,
    });

    expect(messages.data).toHaveLength(1);

    const hits = await new SearchChatMessagesUseCase(
      repos.userRepository,
      repos.chatRepository,
      uploadStub,
    ).execute({
      userId: MASTER_ID,
      search: "Rota",
      limit: 10,
      businessId: BUSINESS,
    });

    expect(hits.data).toHaveLength(1);
  });
});
