import {
  Activity,
  CreateActivityProps,
  CursorPaginatedActivities,
  ListActivitiesCursorProps,
  ListActivityProps,
  ActivitySummary,
  ActivitySummaryProps,
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
  listActivitiesWithCursor: (
    props: ListActivitiesCursorProps,
  ) => Promise<CursorPaginatedActivities>;
  summarizeActivities: (
    props: ActivitySummaryProps,
  ) => Promise<ActivitySummary>;
}

export { IActivityRepository };
