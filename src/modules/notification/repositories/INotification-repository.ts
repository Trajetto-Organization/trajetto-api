import { NotificationCategory, NotificationPreference } from "@prisma/client";

import {
  Notification,
  CreateNotificationProps,
  CursorPaginatedNotifications,
} from "../dtos/notification-dto";

interface ListNotificationsParams {
  userId: string;
  limit?: number;
  includeRead?: boolean;
  cursor?: string; // ID of the last notification from previous page
}

interface UpsertPreferenceInput {
  category: NotificationCategory;
  inApp: boolean;
  email: boolean;
  whatsapp: boolean;
}

interface INotificationRepository {
  createNotification: (
    notificationData: CreateNotificationProps,
  ) => Promise<Notification>;
  listUserNotificationsWithCursor: (
    params: ListNotificationsParams,
  ) => Promise<CursorPaginatedNotifications>;
  markAsRead: (notificationId: string) => Promise<Notification>;
  markAllAsRead: (userId: string) => Promise<number>;
  deleteNotification: (notificationId: string) => Promise<void>;
  findNotificationById: (
    notificationId: string,
  ) => Promise<Notification | null>;
  countUnreadNotifications: (userId: string) => Promise<number>;
  listPreferences: (userId: string) => Promise<NotificationPreference[]>;
  upsertPreferences: (
    userId: string,
    preferences: UpsertPreferenceInput[],
  ) => Promise<void>;
}

export { INotificationRepository, ListNotificationsParams, UpsertPreferenceInput };
