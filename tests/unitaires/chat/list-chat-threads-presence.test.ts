import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { container } from "tsyringe";

/**
 * Presence on the thread list asks about the page, not the company.
 *
 * Every GET of the thread list — and the unread badge refetches it, with
 * pageSize 1, on every chat message, on every staff tab and every driver's
 * phone — ran `fetchSockets` over `business:<id>`: every socket of the
 * company, serialised with its handshake by every replica and published
 * through Redis, to colour at most a page of dots. The question the page
 * asks is "which of THESE drivers is connected".
 */
const presence = vi.hoisted(() => ({
  getOnlineUserIds: vi.fn(async (ids: string[]) =>
    ids.filter((id) => id === "driver-user-1"),
  ),
  getOnlineUserIdsForBusiness: vi.fn(async () => [
    "driver-user-1",
    "driver-user-2",
  ]),
}));

vi.mock("@/websocket", () => presence);

import { ListChatThreadsController } from "@/modules/chat/usecases/list-chat-threads/list-chat-threads-controller";
import { ListChatThreadsUseCase } from "@/modules/chat/usecases/list-chat-threads/list-chat-threads-usecase";

const BUSINESS = "018f0000-0000-7000-8000-00000000b001";

const thread = (id: string, driverUserId: string | null) => ({
  id,
  driverUser: driverUserId ? { id: driverUserId, name: driverUserId } : null,
});

let page: ReturnType<typeof thread>[] = [];

function reply() {
  const sent: { status?: number; body?: any } = {};

  const stub = {
    status(code: number) {
      sent.status = code;
      return stub;
    },
    send(body: unknown) {
      sent.body = body;
      return stub;
    },
  };

  return { stub, sent };
}

async function list() {
  const { stub, sent } = reply();

  await new ListChatThreadsController().handle(
    {
      user: { id: "staff-1" },
      query: { page: 1, pageSize: 20 },
    } as never,
    stub as never,
  );

  return sent;
}

beforeEach(() => {
  container.registerInstance(ListChatThreadsUseCase, {
    execute: async () => ({
      data: page,
      total: page.length,
      totalUnread: 0,
      businessId: BUSINESS,
    }),
  } as never);
});

afterEach(() => {
  vi.clearAllMocks();
  container.clearInstances();
});

describe("presence on the thread list", () => {
  it("asks only about the drivers on the page", async () => {
    page = [
      thread("t1", "driver-user-1"),
      thread("t2", "driver-user-2"),
      thread("t3", null),
    ];

    const sent = await list();

    expect(presence.getOnlineUserIdsForBusiness).not.toHaveBeenCalled();
    expect(presence.getOnlineUserIds).toHaveBeenCalledTimes(1);
    expect(presence.getOnlineUserIds).toHaveBeenCalledWith([
      "driver-user-1",
      "driver-user-2",
    ]);

    expect(sent.status).toBe(200);
    expect(
      sent.body.data.map((entry: any) => entry.driverUser?.online ?? null),
    ).toEqual([true, false, null]);
  });

  it("asks nothing when no thread on the page has a driver user", async () => {
    page = [thread("t1", null)];

    const sent = await list();

    expect(presence.getOnlineUserIds).not.toHaveBeenCalled();
    expect(presence.getOnlineUserIdsForBusiness).not.toHaveBeenCalled();
    expect(sent.status).toBe(200);
  });
});
