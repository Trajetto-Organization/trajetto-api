import { beforeEach, describe, expect, it, vi } from "vitest";

const socket = vi.hoisted(() => ({ sendNotificationsReadToUser: vi.fn() }));

vi.mock("@/websocket", () => socket);

import { InMemoryNotificationRepository } from "@/modules/notification/repositories/in-memory/in-memory-notification-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import { MarkNotificationsReadByEntityUseCase } from "@/modules/notification/usecases/mark-notifications-read-by-entity/mark-notifications-read-by-entity-usecase";

import type { Notification } from "@/modules/notification/dtos/notification-dto";
import type { User } from "@/modules/user/dtos/user-dto";

import { readNotificationsByEntitySchema } from "@/schemas/read-notifications-by-entity-schema";
import { TENANT_MOVE_REFUSED } from "@/shared/validation/tenant-locked-field";

/**
 * POST /notification/read-by-entity (wave 3). The push and the inbox row are
 * separate deliveries of one event, so the app that opens an order from its
 * push never knows the row's id: it names the item, and the caller's unread
 * rows about it turn read. Only the caller's, only that type and item; a
 * repeat changes nothing; each flipped row is announced by its own id,
 * never with the `null` the clients read as "all read".
 */
const ME = "018f3600-0000-7000-8000-0000000000a1";
const OTHER = "018f3600-0000-7000-8000-0000000000a2";
const GHOST = "018f3600-0000-7000-8000-0000000000ff";

const ORDER = "018f3600-0000-7000-8000-0000000000e1";
const OTHER_ORDER = "018f3600-0000-7000-8000-0000000000e2";

function row(
  id: string,
  userId: string,
  type: string,
  entityId: string | null,
  read = false,
): Notification {
  const at = new Date("2026-11-06T12:00:00.000Z");

  return {
    id,
    userId,
    type,
    title: "Nova Ordem de Serviço",
    message: "Você foi designado como responsável.",
    link: null,
    entityId,
    businessId: "018f3600-0000-7000-8000-00000000000a",
    read,
    created_at: at,
    updated_at: at,
  } as unknown as Notification;
}

let users: InMemoryUserRepository;
let notifications: InMemoryNotificationRepository;

beforeEach(() => {
  socket.sendNotificationsReadToUser.mockClear();

  users = new InMemoryUserRepository();
  notifications = new InMemoryNotificationRepository();

  users.user.push(
    { id: ME, role: "BUSINESS_USER" } as unknown as User,
    { id: OTHER, role: "BUSINESS_USER" } as unknown as User,
  );

  notifications.notifications.push(
    // Created, then updated: two rows about the same order.
    row("n-created", ME, "service-order", ORDER),
    row("n-updated", ME, "service-order", ORDER),
    row("n-read", ME, "service-order", ORDER, true),
    row("n-other-order", ME, "service-order", OTHER_ORDER),
    // Same id, another kind of notice: not this item.
    row("n-other-type", ME, "account-payable", ORDER),
    // Someone else's notice about the same order.
    row("n-someone-else", OTHER, "service-order", ORDER),
  );
});

const markRead = () =>
  new MarkNotificationsReadByEntityUseCase(notifications, users);

const isRead = (id: string) =>
  notifications.notifications.find((entry) => entry.id === id)?.read;

describe("POST /notification/read-by-entity", () => {
  it("marks the caller's unread notices of that type about that item, and only those", async () => {
    const count = await markRead().execute({
      userId: ME,
      type: "service-order",
      entityId: ORDER,
    });

    expect(count).toBe(2);
    expect(isRead("n-created")).toBe(true);
    expect(isRead("n-updated")).toBe(true);

    expect(isRead("n-other-order")).toBe(false);
    expect(isRead("n-other-type")).toBe(false);
    expect(isRead("n-someone-else")).toBe(false);
  });

  it("announces each flipped row by its id, never the null of read-all", async () => {
    await markRead().execute({
      userId: ME,
      type: "service-order",
      entityId: ORDER,
    });

    const announced = socket.sendNotificationsReadToUser.mock.calls;

    expect(announced).toEqual([
      [ME, { notificationId: "n-created" }],
      [ME, { notificationId: "n-updated" }],
    ]);
  });

  it("is idempotent: a repeat flips nothing and announces nothing", async () => {
    await markRead().execute({
      userId: ME,
      type: "service-order",
      entityId: ORDER,
    });
    socket.sendNotificationsReadToUser.mockClear();

    const count = await markRead().execute({
      userId: ME,
      type: "service-order",
      entityId: ORDER,
    });

    expect(count).toBe(0);
    expect(socket.sendNotificationsReadToUser).not.toHaveBeenCalled();
  });

  it("refuses a session user that no longer exists (404 USER_NOT_FOUND)", async () => {
    await expect(
      markRead().execute({
        userId: GHOST,
        type: "service-order",
        entityId: ORDER,
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: "USER_NOT_FOUND" });
  });
});

describe("the read-by-entity body", () => {
  it("takes the notice type and the item, trimmed", () => {
    expect(
      readNotificationsByEntitySchema.parse({
        type: "  service-order ",
        entityId: ORDER,
      }),
    ).toEqual({ type: "service-order", entityId: ORDER });
  });

  // Decision 16.100: it edits the caller's rows, so a company in the body is
  // refused like in every edit, whatever the value, not silently stripped.
  it.each(["empresa-1", "018f3600-0000-7000-8000-00000000000b", null])(
    "refuses any company id (%s)",
    (businessId) => {
      const parsed = readNotificationsByEntitySchema.safeParse({
        type: "service-order",
        entityId: ORDER,
        businessId,
      });

      expect(parsed.success).toBe(false);
      expect(parsed.error?.errors.map(({ message }) => message)).toEqual([
        TENANT_MOVE_REFUSED,
      ]);
    },
  );
});
