import { beforeEach, describe, expect, it, vi } from "vitest";

const realtime = vi.hoisted(() => ({
  sendNotificationsReadToUser: vi.fn(),
}));

vi.mock("@/websocket", () => realtime);

import { MarkNotificationAsReadUseCase } from "@/modules/notification/usecases/mark-notification-as-read/mark-notification-as-read-usecase";
import { MarkAllNotificationsReadUseCase } from "@/modules/notification/usecases/mark-all-notifications-read/mark-all-notifications-read-usecase";

/**
 * A read is announced to the reader's other devices (GAP3-13).
 *
 * The app polled /notification/unread-count every 60 s — the single most
 * frequent request a driver makes — for a number that changes a few times a
 * day. New notifications already arrive over the socket; the only change the
 * poll still caught while the socket was up was a read done somewhere else.
 * With this event the app stops polling while connected and polls only as a
 * fallback when the socket is down.
 */
const USER = "user-1";

const users = {
  findUserById: async (id: string) => (id === USER ? { id: USER } : null),
};

function notifications(read: boolean) {
  return {
    findNotificationById: async (id: string) => ({ id, userId: USER, read }),
    markAsRead: vi.fn(async (id: string) => ({ id, userId: USER, read: true })),
    markAllAsRead: vi.fn(async () => 0),
  };
}

beforeEach(() => {
  realtime.sendNotificationsReadToUser.mockClear();
});

describe("marking one notification as read", () => {
  it("tells the user's devices which one", async () => {
    const repository = notifications(false);
    const useCase = new MarkNotificationAsReadUseCase(
      repository as never,
      users as never,
    );

    await useCase.execute({ notificationId: "n-1", userId: USER });

    expect(realtime.sendNotificationsReadToUser).toHaveBeenCalledTimes(1);
    expect(realtime.sendNotificationsReadToUser).toHaveBeenCalledWith(USER, {
      notificationId: "n-1",
    });
  });

  it("says nothing when it was already read: nothing changed", async () => {
    const repository = notifications(true);
    const useCase = new MarkNotificationAsReadUseCase(
      repository as never,
      users as never,
    );

    await useCase.execute({ notificationId: "n-1", userId: USER });

    expect(realtime.sendNotificationsReadToUser).not.toHaveBeenCalled();
  });

  it("says nothing when the write failed", async () => {
    const repository = notifications(false);
    repository.markAsRead.mockRejectedValueOnce(new Error("boom"));

    const useCase = new MarkNotificationAsReadUseCase(
      repository as never,
      users as never,
    );

    await expect(
      useCase.execute({ notificationId: "n-1", userId: USER }),
    ).rejects.toThrow();

    expect(realtime.sendNotificationsReadToUser).not.toHaveBeenCalled();
  });
});

describe("marking every notification as read", () => {
  it("tells the user's devices, with no id, when something flipped", async () => {
    const repository = notifications(false);
    repository.markAllAsRead.mockResolvedValueOnce(3);

    const useCase = new MarkAllNotificationsReadUseCase(
      repository as never,
      users as never,
    );

    expect(await useCase.execute(USER)).toBe(3);

    expect(realtime.sendNotificationsReadToUser).toHaveBeenCalledWith(USER, {
      notificationId: null,
    });
  });

  it("says nothing when there was nothing unread", async () => {
    const repository = notifications(false);

    const useCase = new MarkAllNotificationsReadUseCase(
      repository as never,
      users as never,
    );

    expect(await useCase.execute(USER)).toBe(0);

    expect(realtime.sendNotificationsReadToUser).not.toHaveBeenCalled();
  });
});
