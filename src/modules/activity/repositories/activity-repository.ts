import database from "@/../infra/database";
import {
  ActivitySummary,
  ActivitySummaryProps,
  Activity,
  CreateActivityProps,
  CursorPaginatedActivities,
  ListActivitiesCursorProps,
  ListActivityProps,
  ListRecentActivitiesProps,
} from "../dtos/activity-dto";

import { presentActivityActors } from "@/shared/activity/actor-presentation";

import { IActivityRepository } from "./IActivity-repository";
import { TENANT_VISIBLE } from "@/shared/notifications/policies/business-plan-policies";

import { buildSearchOr } from "@/shared/pagination/search-or";

class ActivityRepository implements IActivityRepository {
  constructor(private prisma = database) {}

  async createActivity(activityData: CreateActivityProps): Promise<Activity> {
    let tenantName: string | null = activityData.tenantName ?? null;

    if (!tenantName && activityData.businessId) {
      const business = await this.prisma.business.findUnique({
        where: { id: activityData.businessId },
        select: { corporate_reason: true },
      });

      tenantName = business?.corporate_reason ?? null;
    }

    const activity = await this.prisma.activity.create({
      data: { ...activityData, tenantName },
    });

    return activity;
  }

  /**
   * Who may see which activities, in one place.
   *
   * The two paginated listings and the cursor feed were built from the same
   * rules, and the rules are subtle enough — a company admin sees the company
   * except MASTER actions, unless the action is its own plan changing — that
   * three copies would have drifted the way the navigation gates did.
   */
  private async buildActivityScope({
    currentUserRole,
    businessId,
    search,
    userId,
    periodDays,
  }: {
    currentUserRole: string;
    businessId?: string | null;
    search?: string;
    userId?: string;
    periodDays?: number;
  }): Promise<any> {
    const normalizedSearch = search ? search.trim().toLowerCase() : "";

    // Get current user to check activity_notifications_enabled
    const currentUser = userId
      ? await this.prisma.user.findUnique({
          where: { id: userId },
          select: {
            id: true,
            role: true,
            businessId: true,
            activity_notifications_enabled: true,
          },
        })
      : null;

    const orConditions: any[] = [];

    if (normalizedSearch) {
      orConditions.push(
        { id: { contains: normalizedSearch, mode: "insensitive" } },
        { type: { contains: normalizedSearch, mode: "insensitive" } },
        { action: { contains: normalizedSearch, mode: "insensitive" } },
        { entityId: { contains: normalizedSearch, mode: "insensitive" } },
        { description: { contains: normalizedSearch, mode: "insensitive" } },
        { status: { contains: normalizedSearch, mode: "insensitive" } },
        { performedBy: { contains: normalizedSearch, mode: "insensitive" } },
        {
          user: {
            email: { contains: normalizedSearch, mode: "insensitive" },
          },
        },
        {
          ...(currentUserRole === "MASTER"
            ? {
                business: {
                  corporate_reason: {
                    contains: normalizedSearch,
                    mode: "insensitive",
                  },
                },
              }
            : {}),
        },
      );
    }

    // Base condition
    let whereCondition: any = {
      ...(currentUserRole !== "MASTER" && businessId ? { businessId } : {}),
      ...buildSearchOr(orConditions),
    };

    // Hierarchical visibility logic based on role and activity_notifications_enabled
    if (currentUserRole === "MASTER") {
      // MASTER sees everything - no additional filters needed
    } else if (currentUserRole === "BUSINESS_ADMIN") {
      // BUSINESS_ADMIN sees all activities from their company
      // EXCLUDES activities created by MASTER (even if they affect their company)
      // Shows activities regardless of user notification settings
      whereCondition = {
        ...whereCondition,
        AND: [
          { businessId: currentUser?.businessId }, // Same company
          {
            OR: [
              { user: { NOT: { role: "MASTER" } } },
              // The one MASTER action a company may see: its own plan
              // changing. Hiding it turned "the menu disappeared" into a
              // support ticket instead of a line on this screen.
              { visibilityLevel: TENANT_VISIBLE },
            ],
          },
        ],
      };
    } else if (currentUserRole === "BUSINESS_USER") {
      // BUSINESS_USER always sees their own activities
      // activity_notifications_enabled only controls real-time notifications, not activity viewing
      whereCondition = {
        ...whereCondition,
        performedBy: currentUser?.id, // Only their own activities
      };
    } else {
      // Default fallback - exclude MASTER activities for non-MASTER roles
      whereCondition = {
        ...whereCondition,
        OR: [
          { user: { NOT: { role: "MASTER" } } },
          { visibilityLevel: TENANT_VISIBLE },
        ],
      };
    }


    // The period is a window on the same scope: the cursor feed and the cards
    // above it must describe the same slice of time, or the numbers lie.
    if (periodDays) {
      const since = new Date();
      since.setDate(since.getDate() - periodDays);

      whereCondition = { ...whereCondition, created_at: { gte: since } };
    }

    return whereCondition;
  }

  async listRecentActivities({
    page,
    pageSize,
    currentUserRole,
    businessId,
    search,
    userId,
  }: ListRecentActivitiesProps): Promise<ListActivityProps> {
    const skip = (page - 1) * pageSize;
    const whereCondition = await this.buildActivityScope({
      currentUserRole,
      businessId,
      search,
      userId,
    });

        const [activities, total] = await Promise.all([
      this.prisma.activity.findMany({
        skip,
        take: pageSize,
        where: whereCondition,
        include: {
          user: {
            select: {
              email: true,
              role: true,
              name: true,
            },
          },
          ...(currentUserRole === "MASTER" && {
            business: {
              select: {
                corporate_reason: true,
              },
            },
          }),
        },
        orderBy: {
          created_at: "desc",
        },
      }),
      this.prisma.activity.count({
        where: whereCondition,
      }),
    ]);

    return {
      data: presentActivityActors(activities, currentUserRole),
      total,
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
    const skip = (page - 1) * pageSize;
    const whereCondition = await this.buildActivityScope({
      currentUserRole,
      businessId,
      search,
      userId,
    });

        const [activities, total] = await Promise.all([
      this.prisma.activity.findMany({
        skip,
        take: pageSize,
        where: whereCondition,
        include: {
          user: {
            select: {
              email: true,
              role: true,
              name: true,
            },
          },
          ...(currentUserRole === "MASTER" && {
            business: {
              select: {
                corporate_reason: true,
              },
            },
          }),
        },
        orderBy: {
          created_at: "desc",
        },
      }),
      this.prisma.activity.count({
        where: whereCondition,
      }),
    ]);

    return {
      data: presentActivityActors(activities, currentUserRole),
      total,
    };
  }

  /**
   * The timeline feed, paginated by keyset rather than by offset.
   *
   * The table below it keeps page numbers, and rightly so — it has a total
   * and column filters. A feed is different: the audit log is written to
   * constantly, so by the time someone asks for "page 2" everything has
   * shifted down and rows already seen come back as duplicates. A cursor is
   * immune to that: it asks for what comes *after a row*, not for a position.
   */
  async listActivitiesWithCursor({
    currentUserRole,
    businessId,
    userId,
    limit,
    cursor,
    search,
    periodDays,
  }: ListActivitiesCursorProps): Promise<CursorPaginatedActivities> {
    const whereCondition = await this.buildActivityScope({
      currentUserRole,
      businessId,
      search,
      userId,
      periodDays,
    });

    // One row past the page: its existence is the only reliable way to know
    // whether a "load more" button should be there at all.
    const activities = await this.prisma.activity.findMany({
      where: whereCondition,
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      include: {
        user: {
          select: {
            email: true,
            role: true,
            name: true,
          },
        },
        ...(currentUserRole === "MASTER" && {
          business: {
            select: {
              corporate_reason: true,
            },
          },
        }),
      },
      // uuid v7 ids are time-ordered, so this is creation order with a unique
      // tiebreaker — two activities written in the same millisecond still have
      // a defined position, which is what keeps the cursor from skipping rows.
      orderBy: { id: "desc" },
    });

    const hasMore = activities.length > limit;
    const data = hasMore ? activities.slice(0, limit) : activities;

    return {
      data: presentActivityActors(data, currentUserRole),
      nextCursor: hasMore ? (data[data.length - 1]?.id ?? null) : null,
      hasMore,
    };
  }

  /**
   * Aggregates over the whole period, never over a page: the cards answer
   * "is anything odd going on?", which a page-scoped count cannot.
   *
   * Visibility follows the same rule as the listing — master sees all,
   * business admin sees the company minus master actions, and a business
   * user only ever sees their own trail.
   */
  async summarizeActivities({
    currentUserRole,
    businessId,
    userId,
    periodDays,
  }: ActivitySummaryProps): Promise<ActivitySummary> {
    const since = new Date();
    since.setDate(since.getDate() - periodDays);

    let whereCondition: any = { created_at: { gte: since } };

    if (currentUserRole === "BUSINESS_ADMIN") {
      whereCondition = {
        ...whereCondition,
        businessId,
        OR: [
          { user: { NOT: { role: "MASTER" } } },
          { visibilityLevel: TENANT_VISIBLE },
        ],
      };
    } else if (currentUserRole === "BUSINESS_USER") {
      whereCondition = { ...whereCondition, performedBy: userId };
    } else if (currentUserRole !== "MASTER") {
      whereCondition = {
        ...whereCondition,
        ...(businessId && { businessId }),
        OR: [
          { user: { NOT: { role: "MASTER" } } },
          { visibilityLevel: TENANT_VISIBLE },
        ],
      };
    } else if (businessId) {
      // Master looking at one company through the selector.
      whereCondition = { ...whereCondition, businessId };
    }

    const [total, byAction, byType, distinctUsers] = await Promise.all([
      this.prisma.activity.count({ where: whereCondition }),
      this.prisma.activity.groupBy({
        by: ["action"],
        where: whereCondition,
        _count: { _all: true },
      }),
      this.prisma.activity.groupBy({
        by: ["type"],
        where: whereCondition,
        _count: { _all: true },
        orderBy: { _count: { type: "desc" } },
        take: 1,
      }),
      this.prisma.activity.findMany({
        where: whereCondition,
        distinct: ["performedBy"],
        select: { performedBy: true },
      }),
    ]);

    const countFor = (action: string): number =>
      byAction.find((row) => row.action === action)?._count._all ?? 0;

    return {
      total,
      created: countFor("create"),
      updated: countFor("update"),
      deleted: countFor("delete"),
      activeUsers: distinctUsers.length,
      topType: byType[0]?.type ?? null,
      topTypeCount: byType[0]?._count._all ?? 0,
      periodDays,
    };
  }
}

export { ActivityRepository };
