import {
  Activity,
  CreateActivityProps,
  ListActivityProps,
  ListRecentActivitiesProps,
} from "../dtos/activity-dto";

interface IActivityRepository {
  createActivity: (activityData: CreateActivityProps) => Promise<Activity>;
  listRecentActivities: ({
    page,
    pageSize,
    currentUserRole,
    businessId,
    search,
  }: ListRecentActivitiesProps) => Promise<ListActivityProps>;
  listAllActivities: ({
    page,
    pageSize,
    currentUserRole,
    businessId,
    search,
    userId,
  }: ListRecentActivitiesProps) => Promise<ListActivityProps>;
}

export { IActivityRepository };
