import {
  Notification,
  CreateNotificationProps,
  ListNotificationsProps,
} from "../dtos/notification-dto";

interface INotificationRepository {
  createNotification: (
    notificationData: CreateNotificationProps,
  ) => Promise<Notification>;
  listUserNotifications: (
    userId: string,
    limit?: number,
    includeRead?: boolean,
  ) => Promise<ListNotificationsProps>;
  markAsRead: (notificationId: string) => Promise<Notification>;
  markAllAsRead: (userId: string) => Promise<void>;
  deleteNotification: (notificationId: string) => Promise<void>;
  findNotificationById: (
    notificationId: string,
  ) => Promise<Notification | null>;
  countUnreadNotifications: (userId: string) => Promise<number>;
}

export { INotificationRepository };
