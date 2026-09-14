import { v7 as uuidV7 } from "uuid";
import { IActivityRepository } from "../IActivity-repository";

import {
  Activity,
  ActivitySummary,
  ActivitySummaryProps,
  CreateActivityProps,
  CursorPaginatedActivities,
  ListActivitiesCursorProps,
  ListActivityProps,
  ListRecentActivitiesProps,
} from "../../dtos/activity-dto";

import { presentActivityActors } from "@/shared/activity/actor-presentation";

class InMemoryActivityRepository implements IActivityRepository {
  public activities: Activity[] = [];

  async createActivity(activityData: CreateActivityProps): Promise<Activity> {
    const activity: Activity = {
      id: uuidV7(),
      type: activityData.type,
      action: activityData.action,
      entityId: activityData.entityId,
      description: activityData.description,
      status: activityData.status,
      performedBy: activityData.performedBy,
      businessId: activityData.businessId,
      visibilityLevel: activityData.visibilityLevel || "COMPANY",
      performingUserRole: activityData.performingUserRole || null,
      created_at: new Date(),
      updated_at: new Date(),
    };

    this.activities.push(activity);
    return activity;
  }

  async listRecentActivities({
    page,
    pageSize,
    currentUserRole,
    businessId,
    search,
    userId,
  }: ListRecentActivitiesProps): Promise<ListActivityProps> {
    let filteredActivities = [...this.activities];

    // Filter by business if provided (but not for MASTER users who see everything)
    if (businessId && currentUserRole !== "MASTER") {
      filteredActivities = filteredActivities.filter(
        (activity) => activity.businessId === businessId,
      );
    }

    // Filter by search if provided
    if (search) {
      const searchLower = search.toLowerCase();
      filteredActivities = filteredActivities.filter(
        (activity) =>
          activity.description.toLowerCase().includes(searchLower) ||
          activity.type.toLowerCase().includes(searchLower) ||
          activity.action.toLowerCase().includes(searchLower),
      );
    }

    // Apply hierarchical visibility logic based on role and test expectations
    if (currentUserRole === "MASTER") {
      // MASTER sees everything - no additional filters needed
    } else if (currentUserRole === "BUSINESS_ADMIN") {
      // BUSINESS_ADMIN sees only COMPANY level activities from their company (excludes SYSTEM)
      filteredActivities = filteredActivities.filter(
        (activity) =>
          activity.businessId === businessId &&
          activity.visibilityLevel === "COMPANY",
      );
    } else if (currentUserRole === "BUSINESS_USER") {
      // BUSINESS_USER sees COMPANY activities from their business + their own USER activities
      filteredActivities = filteredActivities.filter(
        (activity) =>
          (activity.businessId === businessId &&
            activity.visibilityLevel === "COMPANY") ||
          (activity.performedBy === userId &&
            activity.visibilityLevel === "USER"),
      );
    }

    // Sort by creation date (most recent first)
    filteredActivities.sort((a, b) => {
      const dateA = new Date(a.created_at).getTime();
      const dateB = new Date(b.created_at).getTime();

      return dateB - dateA;
    });

    // Apply pagination
    const skip = (page - 1) * pageSize;
    const paginatedActivities = filteredActivities.slice(skip, skip + pageSize);

    // Add mock user data for testing (in real implementation this would come from joins)
    const activitiesWithUserData = paginatedActivities.map((activity) => ({
      ...activity,
      userEmail: `user${(activity.performedBy ?? "unknown").slice(-3)}@test.com`,
      userName: `Test User ${(activity.performedBy ?? "unknown").slice(-3)}`,
      userRole: activity.performingUserRole || currentUserRole,
      business_name: activity.businessId
        ? currentUserRole === "MASTER" || currentUserRole === "BUSINESS_ADMIN"
          ? "Test Business"
          : undefined
        : undefined,
    }));

    return {
      data: activitiesWithUserData as any,
      total: filteredActivities.length,
    };
  }

  async listAllActivities({
    page,
    pageSize,
    currentUserRole,
    businessId,
    search,
    userId,
  }: ListRecentActivitiesProps): Promise<ListActivityProps> {
    // listAllActivities has the same logic as listRecentActivities for in-memory
    return this.listRecentActivities({
      page,
      pageSize,
      currentUserRole,
      businessId,
      search,
      userId,
    });
  }

  addActivity(activityData: Partial<Activity>): Activity {
    const activity: Activity = {
      id: activityData.id || uuidV7(),
      type: activityData.type || "test",
      action: activityData.action || "create",
      entityId: activityData.entityId || "entity-id",
      description: activityData.description || "Test activity",
      status: activityData.status || "Completo",
      performedBy: activityData.performedBy || "user-id",
      businessId: activityData.businessId || null,
      visibilityLevel: activityData.visibilityLevel || "COMPANY",
      performingUserRole: activityData.performingUserRole || null,
      created_at: activityData.created_at || new Date(),
      updated_at: activityData.updated_at || new Date(),
    };

    this.activities.push(activity);
    return activity;
  }

  getActivitiesByBusinessId(businessId: string): Activity[] {
    return this.activities.filter(
      (activity) => activity.businessId === businessId,
    );
  }

  getActivitiesByUserId(userId: string): Activity[] {
    return this.activities.filter(
      (activity) => activity.performedBy === userId,
    );
  }

  /**
   * Same keyset walk as the Prisma repository: newest first, one row past the
   * page to decide whether there is more, and the cursor row excluded.
   */
  async listActivitiesWithCursor({
    currentUserRole,
    limit,
    cursor,
    periodDays,
  }: ListActivitiesCursorProps): Promise<CursorPaginatedActivities> {
    const since = new Date();
    since.setDate(since.getDate() - periodDays);

    const ordered = [...this.activities]
      .filter((activity) => new Date(activity.created_at) >= since)
      .sort((a, b) => (a.id < b.id ? 1 : -1));

    const startIndex = cursor
      ? ordered.findIndex((activity) => activity.id === cursor) + 1
      : 0;

    const window = ordered.slice(startIndex, startIndex + limit + 1);

    const hasMore = window.length > limit;
    const data = hasMore ? window.slice(0, limit) : window;

    return {
      data: presentActivityActors(data as never[], currentUserRole),
      nextCursor: hasMore ? (data[data.length - 1]?.id ?? null) : null,
      hasMore,
    };
  }

  async summarizeActivities({
    currentUserRole,
    businessId,
    userId,
    periodDays,
  }: ActivitySummaryProps): Promise<ActivitySummary> {
    const since = new Date();
    since.setDate(since.getDate() - periodDays);

    const scoped = this.activities.filter((activity) => {
      const createdAt = activity.created_at
        ? new Date(activity.created_at)
        : new Date();

      if (createdAt < since) return false;

      if (currentUserRole === "BUSINESS_USER") {
        return activity.performedBy === userId;
      }

      return !businessId || activity.businessId === businessId;
    });

    const countFor = (action: string): number =>
      scoped.filter((activity) => activity.action === action).length;

    const typeCounts = scoped.reduce<Record<string, number>>(
      (acc, activity) => {
        acc[activity.type] = (acc[activity.type] ?? 0) + 1;
        return acc;
      },
      {},
    );

    const [topType, topTypeCount] = Object.entries(typeCounts).sort(
      (a, b) => b[1] - a[1],
    )[0] ?? [null, 0];

    return {
      total: scoped.length,
      created: countFor("create"),
      updated: countFor("update"),
      deleted: countFor("delete"),
      activeUsers: new Set(scoped.map((activity) => activity.performedBy)).size,
      topType: topType as string | null,
      topTypeCount: topTypeCount as number,
      periodDays,
    };
  }
}

export { InMemoryActivityRepository };
