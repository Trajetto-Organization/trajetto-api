import database from "@/../infra/database";

import {
  Notification,
  CreateNotificationProps,
  ListNotificationsProps,
} from "../dtos/notification-dto";
import { INotificationRepository } from "./INotification-repository";

class NotificationRepository implements INotificationRepository {
  constructor(private prisma = database) {}

  async createNotification(
    notificationData: CreateNotificationProps,
  ): Promise<Notification> {
    const notification = await this.prisma.notification.create({
      data: notificationData,
    });

    return notification;
  }

  async listUserNotifications(
    userId: string,
    limit: number = 20,
    includeRead: boolean = true,
  ): Promise<ListNotificationsProps> {
    const whereClause: any = { userId };

    if (!includeRead) {
      whereClause.read = false;
    }

    const notifications = await this.prisma.notification.findMany({
      where: whereClause,
      orderBy: {
        created_at: "desc",
      },
      take: limit,
    });

    const total = await this.prisma.notification.count({
      where: whereClause,
    });

    const unread = await this.countUnreadNotifications(userId);

    const transformedNotifications = notifications.map((notification) => ({
      id: notification.id,
      userId: notification.userId,
      type: notification.type,
      title: notification.title,
      message: notification.message,
      link: notification.link || undefined,
      read: notification.read,
      entityId: notification.entityId || undefined,
      businessId: notification.businessId || null,
      created_at: notification.created_at.toISOString(),
      updated_at: notification.updated_at.toISOString(),
    }));

    return {
      data: transformedNotifications,
      total,
      unread,
    };
  }

  async markAsRead(notificationId: string): Promise<Notification> {
    const notification = await this.prisma.notification.update({
      where: { id: notificationId },
      data: { read: true },
    });

    return notification;
  }

  async markAllAsRead(userId: string): Promise<void> {
    await this.prisma.notification.updateMany({
      where: {
        userId,
        read: false,
      },
      data: { read: true },
    });
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
