import database from "@/../infra/database";
import { formatNotificationDate } from "@/config/format-values";

import {
  Activity,
  CreateActivityProps,
  ListActivityProps,
  ListRecentActivitiesProps,
} from "../dtos/activity-dto";
import { IActivityRepository } from "./IActivity-repository";

class ActivityRepository implements IActivityRepository {
  constructor(private prisma = database) {}

  async createActivity(activityData: CreateActivityProps): Promise<Activity> {
    const activity = await this.prisma.activity.create({
      data: activityData,
    });

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
    const skip = (page - 1) * pageSize;
    const normalizedSearch = search ? search.trim().toLowerCase() : "";

    // Get current user to check activity_notifications_enabled
    const currentUser = userId ? await this.prisma.user.findUnique({
      where: { id: userId },
      select: { 
        id: true, 
        role: true, 
        businessId: true,
        activity_notifications_enabled: true 
      }
    }) : null;

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
          business: {
            corporate_reason: {
              contains: normalizedSearch,
              mode: "insensitive",
            },
          },
        },
      );
    }

    // Base condition
    let whereCondition: any = {
      ...(currentUserRole !== "MASTER" && businessId ? { businessId } : {}),
      ...(orConditions.length > 0 && { OR: orConditions }),
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
            user: {
              NOT: { role: "MASTER" } // Exclude MASTER activities
            }
          }
        ]
      };
    } else if (currentUserRole === "BUSINESS_USER") {
      // BUSINESS_USER always sees their own activities
      // activity_notifications_enabled only controls real-time notifications, not activity viewing
      whereCondition = {
        ...whereCondition,
        performedBy: currentUser?.id // Only their own activities
      };
    } else {
      // Default fallback - exclude MASTER activities for non-MASTER roles
      whereCondition = {
        ...whereCondition,
        user: {
          NOT: { role: "MASTER" }
        }
      };
    }

    const activities = await this.prisma.activity.findMany({
      skip,
      take: pageSize,
      where: whereCondition,
      orderBy: {
        created_at: "desc",
      },
      include: {
        user: {
          select: {
            email: true,
            role: true,
            name: true,
          },
        },
        business: {
          select: {
            corporate_reason: true,
          },
        },
      },
    });

    const total = await this.prisma.activity.count({
      where: whereCondition,
    });

    const transformedActivities = activities.map((activity) => ({
      id: activity.id,
      type: activity.type,
      action: activity.action,
      entityId: activity.entityId,
      description: activity.description,
      status: activity.status,
      performedBy: activity.performedBy,
      businessId: activity.businessId,
      userEmail: activity.user?.email ?? "N/A",
      userName: activity.user?.name ?? "N/A",
      userRole: activity.user?.role ?? "N/A",
      ...(currentUserRole === "MASTER"
        ? { business_name: activity.business?.corporate_reason ?? "N/A" }
        : {}),
      created_at: formatNotificationDate(activity.created_at, "pt-BR") ?? "N/A",
      updated_at: formatNotificationDate(activity.updated_at, "pt-BR") ?? "N/A",
    }));

    return { data: transformedActivities, total };
  }
}

export { ActivityRepository };
