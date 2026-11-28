import { Prisma } from "@prisma/client";

import type { ActivityDataVersion } from "@/shared/activity/activity-data-version";

import {
  Activity,
  CreateActivityProps,
  CursorPaginatedActivities,
  ListActivitiesCursorProps,
  ListActivityProps,
  ActivitySummary,
  ActivitySummaryProps,
  ListRecentActivitiesProps,
  ListRecentActivitiesPreviewProps,
} from "../dtos/activity-dto";

interface IActivityRepository {
  /**
   * With `tx`, the entry commits or rolls back with the caller's write: an
   * audit trail that says something happened only when it did.
   */
  createActivity: (
    activityData: CreateActivityProps,
    tx?: Prisma.TransactionClient,
  ) => Promise<Activity>;
  /**
   * The newest `take` activities in the caller's scope, and nothing else:
   * no total. For surfaces that show a handful of lines and no pager, where
   * the COUNT next to the page would scan the whole trail to be discarded.
   */
  listRecentActivitiesPreview: (
    props: ListRecentActivitiesPreviewProps,
  ) => Promise<Activity[]>;
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
  /**
   * The generation of ids the trail serves (plano-escala F2-18): "1" until
   * the copy window re-keys it, "2" from then on
   * (src/shared/activity/activity-data-version.ts).
   */
  dataVersion: () => Promise<ActivityDataVersion>;
}

export { IActivityRepository };
