import type { NotificationPreference } from "@prisma/client";
import { v7 as uuidV7 } from "uuid";

import type {
  CreateNotificationProps,
  CursorPaginatedNotifications,
  Notification,
} from "../../dtos/notification-dto";
import type {
  INotificationRepository,
  ListNotificationsParams,
  UpsertPreferenceInput,
} from "../INotification-repository";

import { afterCursor, newestFirst } from "@/shared/in-memory/cursor";
import { requireIndex } from "@/shared/in-memory/prisma-errors";

/**
 * The inbox and its preferences, with the Prisma repository's semantics
 * (decision 13.2, tests/contract/repositories/notification.contract.ts):
 * newest first with the id breaking a tie, Prisma's cursor, P2025 on a
 * missing row, one preference per (user, category).
 */
class InMemoryNotificationRepository implements INotificationRepository {
  public notifications: Notification[] = [];
  public preferences: NotificationPreference[] = [];

  async createNotification(
    data: CreateNotificationProps,
  ): Promise<Notification> {
    const now = new Date();
    const notification: Notification = {
      id: uuidV7(),
      userId: data.userId,
      type: data.type,
      title: data.title,
      message: data.message,
      link: data.link ?? null,
      entityId: data.entityId ?? null,
      businessId: data.businessId ?? null,
      read: false,
      created_at: now,
      updated_at: now,
    };

    this.notifications.push(notification);

    return notification;
  }

  async listUserNotificationsWithCursor({
    userId,
    limit = 20,
    includeRead = true,
    cursor,
  }: ListNotificationsParams): Promise<CursorPaginatedNotifications> {
    const matching = this.notifications
      .filter((row) => row.userId === userId && (includeRead || !row.read))
      .sort(newestFirst);

    const window = afterCursor(
      matching,
      this.notifications,
      cursor,
      newestFirst,
    ).slice(0, limit + 1);

    const hasMore = window.length > limit;
    const data = hasMore ? window.slice(0, limit) : window;

    return {
      data,
      total: matching.length,
      unread: await this.countUnreadNotifications(userId),
      nextCursor: hasMore ? (data[data.length - 1]?.id ?? null) : null,
      hasMore,
    };
  }

  async markAsRead(notificationId: string): Promise<Notification> {
    const row =
      this.notifications[
        requireIndex(this.notifications, (entry) => entry.id === notificationId)
      ];

    row.read = true;
    row.updated_at = new Date();

    return row;
  }

  async markAllAsRead(userId: string): Promise<number> {
    const unread = this.notifications.filter(
      (row) => row.userId === userId && !row.read,
    );

    for (const row of unread) {
      row.read = true;
      row.updated_at = new Date();
    }

    return unread.length;
  }

  async deleteNotification(notificationId: string): Promise<void> {
    const index = requireIndex(
      this.notifications,
      (entry) => entry.id === notificationId,
      "delete",
    );

    this.notifications.splice(index, 1);
  }

  async findNotificationById(
    notificationId: string,
  ): Promise<Notification | null> {
    return this.notifications.find((row) => row.id === notificationId) ?? null;
  }

  async countUnreadNotifications(userId: string): Promise<number> {
    return this.notifications.filter(
      (row) => row.userId === userId && !row.read,
    ).length;
  }

  async listPreferences(userId: string): Promise<NotificationPreference[]> {
    return this.preferences.filter((row) => row.userId === userId);
  }

  /** The upsert on @@unique([userId, category]), all or nothing like the transaction. */
  async upsertPreferences(
    userId: string,
    preferences: UpsertPreferenceInput[],
  ): Promise<void> {
    const now = new Date();

    for (const preference of preferences) {
      const existing = this.preferences.find(
        (row) => row.userId === userId && row.category === preference.category,
      );

      if (existing) {
        Object.assign(existing, {
          inApp: preference.inApp,
          email: preference.email,
          whatsapp: preference.whatsapp,
          updated_at: now,
        });
        continue;
      }

      this.preferences.push({
        id: uuidV7(),
        userId,
        category: preference.category,
        inApp: preference.inApp,
        email: preference.email,
        whatsapp: preference.whatsapp,
        created_at: now,
        updated_at: now,
      });
    }
  }
}

export { InMemoryNotificationRepository };
