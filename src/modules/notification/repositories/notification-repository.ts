import database from "@/../infra/database";
import { NotificationPreference } from "@prisma/client";

import {
  Notification,
  CreateNotificationProps,
  CursorPaginatedNotifications,
} from "../dtos/notification-dto";

import {
  INotificationRepository,
  ListNotificationsParams,
  UpsertPreferenceInput,
} from "./INotification-repository";

class NotificationRepository implements INotificationRepository {
  constructor(private prisma = database) {}

  async markAllAsRead(userId: string): Promise<number> {
    const result = await this.prisma.notification.updateMany({
      where: { userId, read: false },
      data: { read: true },
    });

    return result.count;
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
    const whereClause: any = { userId };

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
      orderBy: {
        created_at: "desc",
      },
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
      },
    });
  }
}

export { NotificationRepository };
