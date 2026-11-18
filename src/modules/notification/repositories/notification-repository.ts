import database from "@/../infra/database";
import { NotificationPreference } from "@prisma/client";

import { env } from "@/env";
import { bellIdRange } from "@/shared/notifications/bell-id-range";

import {
  Notification,
  CreateNotificationProps,
  CursorPaginatedNotifications,
} from "../dtos/notification-dto";

import {
  INotificationRepository,
  ListNotificationsParams,
  NotificationEntityRef,
  UpsertPreferenceInput,
} from "./INotification-repository";

/**
 * The ids the bell's reads look at (bell-id-range.ts, plano-escala F5-15):
 * on the bell partitioned by month, the months the retention keeps and
 * none of the ones made ahead.
 */
function keptIds() {
  return bellIdRange(env.NOTIFICATION_UNREAD_RETENTION_DAYS);
}

class NotificationRepository implements INotificationRepository {
  constructor(private prisma = database) {}

  async markAllAsRead(userId: string): Promise<number> {
    const result = await this.prisma.notification.updateMany({
      where: { userId, read: false, id: keptIds() },
      data: { read: true },
    });

    return result.count;
  }

  async markReadByEntity({
    userId,
    type,
    entityId,
  }: NotificationEntityRef): Promise<string[]> {
    // The user leads the where (the (userId, read, created_at) index): only
    // the caller's own rows can ever be touched.
    const flipped = await this.prisma.notification.updateManyAndReturn({
      where: { userId, type, entityId, read: false, id: keptIds() },
      data: { read: true },
      select: { id: true },
    });

    return flipped.map((row) => row.id);
  }

  async listPreferences(userId: string): Promise<NotificationPreference[]> {
    return this.prisma.notificationPreference.findMany({
      where: { userId },
    });
  }

  async upsertPreferences(
    userId: string,
    preferences: UpsertPreferenceInput[],
  ): Promise<void> {
    await this.prisma.$transaction(
      preferences.map((preference) =>
        this.prisma.notificationPreference.upsert({
          where: {
            userId_category: { userId, category: preference.category },
          },
          create: {
            userId,
            category: preference.category,
            inApp: preference.inApp,
            email: preference.email,
            whatsapp: preference.whatsapp,
          },
          update: {
            inApp: preference.inApp,
            email: preference.email,
            whatsapp: preference.whatsapp,
          },
        }),
      ),
    );
  }

  async createNotification(
    notificationData: CreateNotificationProps,
  ): Promise<Notification> {
    const notification = await this.prisma.notification.create({
      data: notificationData,
    });

    return notification;
  }

  async listUserNotificationsWithCursor({
    userId,
    limit = 20,
    includeRead = true,
    cursor,
  }: ListNotificationsParams): Promise<CursorPaginatedNotifications> {
    const whereClause: any = { userId, id: keptIds() };

    if (!includeRead) {
      whereClause.read = false;
    }

    // Cursor-based pagination: fetch limit + 1 to check if there are more
    const notifications = await this.prisma.notification.findMany({
      where: whereClause,
      take: limit + 1,
      ...(cursor && {
        cursor: { id: cursor },
        skip: 1, // Skip the cursor item itself
      }),
      // The id breaks created_at ties. The notification pipeline writes a
      // whole fan-out in one instant, and a cursor over a non-unique order
      // re-reads the same tied row on every page (skip: 1 always drops the
      // first of the ties) while the others are never shown.
      orderBy: [{ created_at: "desc" }, { id: "desc" }],
    });

    // Check if there are more items
    const hasMore = notifications.length > limit;
    const data = hasMore ? notifications.slice(0, limit) : notifications;

    const nextCursor = hasMore ? data[data.length - 1]?.id : null;

    // Get total count and unread count in parallel
    const [total, unread] = await Promise.all([
      this.prisma.notification.count({ where: whereClause }),
      this.countUnreadNotifications(userId),
    ]);

    return {
      data,
      total,
      unread,
      nextCursor,
      hasMore,
    };
  }

  async markAsRead(notificationId: string): Promise<Notification> {
    const notification = await this.prisma.notification.update({
      where: { id: notificationId },
      data: { read: true },
    });

    return notification;
  }

  async deleteNotification(notificationId: string): Promise<void> {
    await this.prisma.notification.delete({
      where: { id: notificationId },
    });
  }

  async findNotificationById(
    notificationId: string,
  ): Promise<Notification | null> {
    return this.prisma.notification.findUnique({
      where: { id: notificationId },
    });
  }

  async countUnreadNotifications(userId: string): Promise<number> {
    return this.prisma.notification.count({
      where: {
        userId,
        read: false,
        id: keptIds(),
      },
    });
  }
}

export { NotificationRepository };
