import {
  CreateActivityProps,
  CreateNotificationProps,
} from "../notification-service";

class InMemoryNotificationService {
  public activities: CreateActivityProps[] = [];
  public notifications: CreateNotificationProps[] = [];

  async createActivityIfEnabled(
    activityData: CreateActivityProps,
  ): Promise<void> {
    this.activities.push(activityData);
  }

  async createNotificationIfEnabled(
    notificationData: CreateNotificationProps,
  ): Promise<void> {
    this.notifications.push(notificationData);
  }

  async processUserNotifications(params: {
    activity?: CreateActivityProps;
    notification?: CreateNotificationProps;
  }): Promise<void> {
    if (params.activity) {
      await this.createActivityIfEnabled(params.activity);
    }

    if (params.notification) {
      await this.createNotificationIfEnabled(params.notification);
    }
  }
}

export { InMemoryNotificationService };
