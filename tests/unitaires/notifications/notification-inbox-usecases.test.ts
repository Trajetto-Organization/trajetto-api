import { describe, expect, it, vi } from "vitest";

// The socket server is not up in unit tests; these use cases do not emit.
vi.mock("@/websocket", () => ({ sendNotificationsReadToUser: vi.fn() }));

import { NotificationCategory } from "@prisma/client";

import { CountUnreadNotificationsUseCase } from "@/modules/notification/usecases/count-unread-notifications/count-unread-notifications-usecase";
import { DeleteNotificationUseCase } from "@/modules/notification/usecases/delete-notification/delete-notification-usecase";
import { ListUserNotificationsCursorUseCase } from "@/modules/notification/usecases/list-user-notifications-cursor/list-user-notifications-cursor-usecase";
import { GetNotificationPreferencesUseCase } from "@/modules/notification/usecases/manage-preferences/get-notification-preferences-usecase";
import { UpdateNotificationPreferencesUseCase } from "@/modules/notification/usecases/manage-preferences/update-notification-preferences-usecase";

import { InMemoryNotificationRepository } from "@/modules/notification/repositories/in-memory/in-memory-notification-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import type { Notification } from "@/modules/notification/dtos/notification-dto";
import type { User } from "@/modules/user/dtos/user-dto";

/**
 * The inbox is strictly personal: every read, count and delete is scoped to
 * the caller, someone else's notification answers exactly like a missing one
 * (decision 11.3), a repository failure is a 500 with a pt-BR message, and
 * the preferences screen shows only the categories the role can receive,
 * falling back to the legacy global toggles until a category is saved.
 */
const ME = "018f0000-0000-7000-8000-0000000000a1";
const OTHER = "018f0000-0000-7000-8000-0000000000a2";
const ADMIN = "018f0000-0000-7000-8000-0000000000a3";
const MASTER = "018f0000-0000-7000-8000-0000000000a4";
const GHOST = "018f0000-0000-7000-8000-0000000000ff";

function notification(id: string, userId: string, minute: number, read = false): Notification {
  const at = new Date(Date.UTC(2026, 9, 6, 12, minute));

  return {
    id,
    userId,
    type: "ACTIVITY",
    title: `Aviso ${id}`,
    message: "Mensagem",
    link: null,
    entityId: null,
    businessId: null,
    read,
    created_at: at,
    updated_at: at,
  } as unknown as Notification;
}

function makeContext() {
  const users = new InMemoryUserRepository();
  const notifications = new InMemoryNotificationRepository();

  users.user.push(
    {
      id: ME,
      role: "BUSINESS_USER",
      activity_notifications_enabled: false,
      email_notifications_enabled: true,
      whatsapp_notifications_enabled: true,
    } as unknown as User,
    { id: OTHER, role: "BUSINESS_USER" } as unknown as User,
    { id: ADMIN, role: "BUSINESS_ADMIN" } as unknown as User,
    { id: MASTER, role: "MASTER" } as unknown as User,
  );

  notifications.notifications.push(
    notification("n-1", ME, 1),
    notification("n-2", ME, 2, true),
    notification("n-3", ME, 3),
    notification("n-4", OTHER, 4),
  );

  return {
    users,
    notifications,
    count: new CountUnreadNotificationsUseCase(users, notifications),
    remove: new DeleteNotificationUseCase(notifications, users),
    list: new ListUserNotificationsCursorUseCase(users, notifications),
    getPreferences: new GetNotificationPreferencesUseCase(notifications, users),
    updatePreferences: new UpdateNotificationPreferencesUseCase(notifications, users),
  };
}

describe("counting unread notifications", () => {
  it("counts only the caller's unread ones", async () => {
    const context = makeContext();

    await expect(context.count.execute(ME)).resolves.toEqual({ count: 2 });
    await expect(context.count.execute(OTHER)).resolves.toEqual({ count: 1 });
  });

  it("refuses an unknown user with 404", async () => {
    const context = makeContext();

    await expect(context.count.execute(GHOST)).rejects.toMatchObject({
      statusCode: 404,
      code: "USER_NOT_FOUND",
    });
  });

  it("turns a repository failure into a pt-BR 500", async () => {
    const context = makeContext();
    vi.spyOn(context.notifications, "countUnreadNotifications").mockRejectedValueOnce(new Error("down"));

    await expect(context.count.execute(ME)).rejects.toMatchObject({
      statusCode: 500,
      message: expect.stringContaining("notificações não lidas"),
    });
  });
});

describe("listing the inbox with a cursor", () => {
  it("returns the caller's notifications newest first, paged by cursor", async () => {
    const context = makeContext();

    const first = await context.list.execute({ userId: ME, limit: 2 });

    expect(first.data.map((row) => row.id)).toEqual(["n-3", "n-2"]);
    expect(first).toMatchObject({ total: 3, unread: 2, hasMore: true, nextCursor: "n-2" });

    const second = await context.list.execute({ userId: ME, limit: 2, cursor: first.nextCursor ?? undefined });

    expect(second.data.map((row) => row.id)).toEqual(["n-1"]);
    expect(second).toMatchObject({ hasMore: false, nextCursor: null });
  });

  it("hides read ones when asked, and never shows another user's", async () => {
    const context = makeContext();

    const unreadOnly = await context.list.execute({ userId: ME, includeRead: false });

    expect(unreadOnly.data.map((row) => row.id)).toEqual(["n-3", "n-1"]);
    expect(unreadOnly.total).toBe(2);
    expect(unreadOnly.data.every((row) => row.userId === ME)).toBe(true);
  });

  it("refuses an unknown user with 404", async () => {
    const context = makeContext();

    await expect(context.list.execute({ userId: GHOST })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("turns a repository failure into a pt-BR 500", async () => {
    const context = makeContext();
    vi.spyOn(context.notifications, "listUserNotificationsWithCursor").mockRejectedValueOnce(new Error("down"));

    await expect(context.list.execute({ userId: ME })).rejects.toMatchObject({ statusCode: 500 });
  });
});

describe("deleting a notification", () => {
  it("deletes the caller's own notification", async () => {
    const context = makeContext();

    await context.remove.execute({ notificationId: "n-1", userId: ME });

    expect(context.notifications.notifications.map((row) => row.id)).not.toContain("n-1");
  });

  it("answers another user's notification exactly like a missing one and keeps it", async () => {
    const context = makeContext();

    const foreign = await context.remove
      .execute({ notificationId: "n-4", userId: ME })
      .catch((error) => error);
    const missing = await context.remove
      .execute({ notificationId: "nope", userId: ME })
      .catch((error) => error);

    expect(foreign).toMatchObject({ statusCode: 404, code: "NOTIFICATION_NOT_FOUND" });
    expect(missing).toMatchObject({ statusCode: 404, code: "NOTIFICATION_NOT_FOUND" });
    expect(foreign.message).toBe(missing.message);
    expect(context.notifications.notifications.map((row) => row.id)).toContain("n-4");
  });

  it("refuses an unknown user before looking at the notification", async () => {
    const context = makeContext();

    await expect(context.remove.execute({ notificationId: "n-1", userId: GHOST })).rejects.toMatchObject({
      statusCode: 404,
      code: "USER_NOT_FOUND",
    });
    expect(context.notifications.notifications).toHaveLength(4);
  });

  it("turns a repository failure into a pt-BR 500", async () => {
    const context = makeContext();
    vi.spyOn(context.notifications, "deleteNotification").mockRejectedValueOnce(new Error("down"));

    await expect(context.remove.execute({ notificationId: "n-1", userId: ME })).rejects.toMatchObject({
      statusCode: 500,
      message: expect.stringContaining("excluir a notificação"),
    });
  });
});

describe("notification preferences", () => {
  it("shows a role only the categories it can receive", async () => {
    const context = makeContext();

    const master = await context.getPreferences.execute(MASTER);
    const admin = await context.getPreferences.execute(ADMIN);
    const user = await context.getPreferences.execute(ME);

    expect(master.map((row) => row.category)).toEqual([NotificationCategory.ACCOUNT]);
    expect(admin.map((row) => row.category)).toEqual([
      NotificationCategory.FINES,
      NotificationCategory.MAINTENANCE,
      NotificationCategory.FINANCE,
      NotificationCategory.TASKS,
    ]);
    expect(user.map((row) => row.category)).not.toContain(NotificationCategory.FINES);
    expect([...master, ...admin, ...user].map((row) => row.category)).not.toContain(NotificationCategory.SYSTEM);
  });

  it("falls back to the legacy global toggles until a category is saved", async () => {
    const context = makeContext();

    const before = await context.getPreferences.execute(ME);

    expect(before.every((row) => row.isDefault)).toBe(true);
    expect(before[0]).toMatchObject({ inApp: false, email: true, whatsapp: true });

    await context.updatePreferences.execute(ME, [
      { category: NotificationCategory.TASKS, inApp: true, email: false, whatsapp: false },
    ]);

    const after = await context.getPreferences.execute(ME);
    const tasks = after.find((row) => row.category === NotificationCategory.TASKS);
    const finance = after.find((row) => row.category === NotificationCategory.FINANCE);

    expect(tasks).toEqual({
      category: NotificationCategory.TASKS,
      inApp: true,
      email: false,
      whatsapp: false,
      isDefault: false,
    });
    expect(finance?.isDefault).toBe(true);
  });

  it("saves one row per category and never touches another user's preferences", async () => {
    const context = makeContext();

    await context.updatePreferences.execute(OTHER, [
      { category: NotificationCategory.TASKS, inApp: false, email: false, whatsapp: false },
    ]);
    await context.updatePreferences.execute(ME, [
      { category: NotificationCategory.TASKS, inApp: true, email: true, whatsapp: false },
    ]);
    await context.updatePreferences.execute(ME, [
      { category: NotificationCategory.TASKS, inApp: false, email: true, whatsapp: true },
    ]);

    const mine = context.notifications.preferences.filter((row) => row.userId === ME);
    const theirs = context.notifications.preferences.find((row) => row.userId === OTHER);

    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ inApp: false, email: true, whatsapp: true });
    expect(theirs).toMatchObject({ inApp: false, email: false, whatsapp: false });
  });

  it("refuses an unknown user with 404 on read and write", async () => {
    const context = makeContext();

    await expect(context.getPreferences.execute(GHOST)).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      context.updatePreferences.execute(GHOST, [
        { category: NotificationCategory.TASKS, inApp: true, email: true, whatsapp: true },
      ]),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(context.notifications.preferences).toHaveLength(0);
  });
});
