interface CreateNotificationProps {
  userId: string; // recipient user ID
  type: string; // Notification type (service-order, vehicle, etc.)
  title: string; // Notification title
  message: string; // Notification content
  link?: string | null; // Optional link to redirect - add null here
  entityId?: string | null; // Related Entity ID (optional) - add null here
  businessId: string | null; // Company ID - add null here
  shouldSendEmail?: boolean; // Add this if needed
}

interface Notification {
  id: string;
  userId: string;
  type: string;
  title: string;
  message: string;
  link?: string | null; // Change to string | null
  read: boolean;
  entityId?: string | null; // Change to string | null
  businessId: string | null; // Change to string | null
  created_at: Date | string;
  updated_at: Date | string;
}

interface ListNotificationsProps {
  data: Notification[];
  total: number;
  unread: number;
}

export { Notification, CreateNotificationProps, ListNotificationsProps };
