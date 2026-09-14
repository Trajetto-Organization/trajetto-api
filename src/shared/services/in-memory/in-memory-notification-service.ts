import {
  CreateActivityProps,
  NotificationService,
} from "../notification-service";

class InMemoryNotificationService extends NotificationService {
  public activities: CreateActivityProps[] = [];

  constructor(userRepository: any) {
    super(userRepository);
  }

  async createActivityIfEnabled(
    activityData: CreateActivityProps,
  ): Promise<void> {
    this.activities.push(activityData);
  }
}

export { InMemoryNotificationService };
