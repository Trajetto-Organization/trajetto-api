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

interface INotificationRepository {
  createNotification: (
    notificationData: CreateNotificationProps,
  ) => Promise<Notification>;
  listUserNotificationsWithCursor: (
    params: ListNotificationsParams,
  ) => Promise<CursorPaginatedNotifications>;
  markAsRead: (notificationId: string) => Promise<Notification>;
  deleteNotification: (notificationId: string) => Promise<void>;
  findNotificationById: (
    notificationId: string,
  ) => Promise<Notification | null>;
  countUnreadNotifications: (userId: string) => Promise<number>;
}

export { INotificationRepository, ListNotificationsParams };
