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

/** The caller's notices about one item (wave 3). */
interface NotificationEntityRef {
  userId: string;
  type: string;
  entityId: string;
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
  /**
   * Marks this user's unread notices of this type about this item as read
   * and returns the ids it flipped (none when there was nothing to flip).
   */
  markReadByEntity: (ref: NotificationEntityRef) => Promise<string[]>;
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

export {
  INotificationRepository,
  ListNotificationsParams,
  NotificationEntityRef,
  UpsertPreferenceInput,
};
