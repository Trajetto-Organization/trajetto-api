import { inject, injectable } from "tsyringe";

import { IDashboardRepository } from "../../repositories/IDashboard-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { IActivityRepository } from "@/modules/activity/repositories/IActivity-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";

interface DashboardOverviewRequest {
  userId: string;
}

interface EntityCount {
  currentMonth: number;
  lastMonth: number;
}

interface DashboardOverviewResponse {
  counts: {
    vehicles: EntityCount;
    drivers: EntityCount;
    businesses: EntityCount;
    branches: EntityCount;
    parts: EntityCount;
    suppliers: EntityCount;
    serviceOrders: EntityCount;
    users: EntityCount;
    fines: EntityCount;
  };
  vehicleStatus: {
    ACTIVE: number;
    INACTIVE: number;
    BLOCKED: number;
    IN_ROUTE: number;
  };
  activityTrends: Array<{
    month: string;
    vehicles: number;
    drivers: number;
    businesses: number;
    branches: number;
    parts: number;
    suppliers: number;
    serviceOrders: number;
    users: number;
    fines: number;
  }>;
  maintenanceStats: {
    pending: number;
    recent: number;
    overdue: number;
  };
  recentActivity: Array<{
    id: string;
    type: string;
    description: string;
    userEmail: string;
    userName: string;
    userRole: string;
    business_name?: string;
    date: string;
    status: string;
  }>;
  vehiclesByType: Array<{
    name: string;
    count: number;
  }>;
  maintenanceCosts: Array<{
    month: string;
    preventive: number;
    corrective: number;
  }>;
}

const pluralizeFieldName = (key: string): string => {
  const pluralMap: Record<string, string> = {
    business: "businesses",
    branch: "branches",
    "service-order": "serviceOrders",
    fine: "fines",
  };

  // If it exists in the mapping, use the mapped value.
  if (pluralMap[key]) {
    return pluralMap[key];
  }

  // For regular words, just add 's'.
  return key + "s";
};

@injectable()
class GetDashboardOverviewUseCase {
  constructor(
    @inject("UserRepository")
    private userRepository: IUserRepository,
    @inject("DashboardRepository")
    private dashboardRepository: IDashboardRepository,
    @inject("ActivityRepository")
    private activityRepository: IActivityRepository,
  ) {}

  async execute({
    userId,
  }: DashboardOverviewRequest): Promise<DashboardOverviewResponse> {
    const user = await this.userRepository.findUserById(userId);

    if (!user) {
      throw new ResourceNotFoundError();
    }

    try {
      const businessId =
        user.role !== "MASTER" ? (user.businessId as string) : undefined;

      // Get current date for calculations
      const now = new Date();

      const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const currentMonthEnd = new Date(
        now.getFullYear(),
        now.getMonth() + 1,
        0,
      );

      const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);

      // Helper function to check permissions for BUSINESS_USER
      const hasPermission = (permissionKey: string): boolean => {
        if (user.role !== "BUSINESS_USER") return true;
        return (
          user.profileAccess?.permissions?.some(
            (perm) =>
              perm.permissionKey === permissionKey &&
              (perm.canRead || perm.canWrite),
          ) ?? false
        );
      };

      // Get entity counts
      const entities = [
        { key: "vehicle", permission: "vehicle_manage" },
        { key: "driver", permission: "driver_manage" },
        { key: "business", permission: "business_manage" },
        { key: "branch", permission: "branch_manage" },
        { key: "part", permission: "part_manage" },
        { key: "supplier", permission: "supplier_manage" },
        { key: "service-order", permission: "service_order_manage" },
        { key: "user", permission: "user_registration_manage" },
        { key: "fine", permission: "fine_manage" },
      ];

      const counts: any = {};

      for (const entity of entities) {
        // Skip businesses for BUSINESS_ADMIN
        if (user.role === "BUSINESS_ADMIN" && entity.key === "business") {
          counts[entity.key] = { currentMonth: 0, lastMonth: 0 };
          continue;
        }

        // Check permissions for BUSINESS_USER
        if (!hasPermission(entity.permission)) {
          counts[entity.key] = { currentMonth: 0, lastMonth: 0 };
          continue;
        }

        const [currentCount, lastCount] = await Promise.all([
          this.dashboardRepository.countByDateRange(
            {
              entity: entity.key as any,
              startDate: currentMonthStart.toISOString().split("T")[0],
              endDate: currentMonthEnd.toISOString().split("T")[0],
            },
            businessId,
          ),
          this.dashboardRepository.countByDateRange(
            {
              entity: entity.key as any,
              startDate: lastMonthStart.toISOString().split("T")[0],
              endDate: lastMonthEnd.toISOString().split("T")[0],
            },
            businessId,
          ),
        ]);

        counts[entity.key] = {
          currentMonth: currentCount.count,
          lastMonth: lastCount.count,
        };
      }

      // Get activity trends for last 6 months
      const monthNames = [
        "Jan",
        "Fev",
        "Mar",
        "Abr",
        "Mai",
        "Jun",
        "Jul",
        "Ago",
        "Set",
        "Out",
        "Nov",
        "Dez",
      ];

      const activityTrends = [];

      const currentMonth = now.getMonth();
      const currentYear = now.getFullYear();

      for (let i = 5; i >= 0; i--) {
        let month = currentMonth - i;
        let year = currentYear;

        if (month < 0) {
          month += 12;
          year--;
        }

        const startDate = new Date(year, month, 1);
        const endDate = new Date(year, month + 1, 0);

        const monthData: any = {
          month: monthNames[month],
        };

        // Get counts for each entity type for this month
        const monthlyPromises = entities.map(async (entity) => {
          if (
            (user.role === "BUSINESS_ADMIN" && entity.key === "business") ||
            !hasPermission(entity.permission)
          ) {
            return { key: entity.key, count: 0 };
          }

          const result = await this.dashboardRepository.countByDateRange(
            {
              entity: entity.key as any,
              startDate: startDate.toISOString().split("T")[0],
              endDate: endDate.toISOString().split("T")[0],
            },
            businessId,
          );

          return { key: entity.key, count: result.count };
        });

        const monthlyResults = await Promise.all(monthlyPromises);

        monthlyResults.forEach(({ key, count }) => {
          const fieldName = pluralizeFieldName(key);
          monthData[fieldName] = count;
        });

        activityTrends.push(monthData);
      }

      // Get vehicle-specific data
      let vehicleStatus = { ACTIVE: 0, INACTIVE: 0, BLOCKED: 0, IN_ROUTE: 0 };
      let maintenanceStats = { pending: 0, recent: 0, overdue: 0 };

      let vehiclesByType: any = [];

      if (hasPermission("vehicle_manage")) {
        [vehicleStatus, maintenanceStats, vehiclesByType] = await Promise.all([
          this.dashboardRepository.countVehiclesByStatus(businessId),
          this.dashboardRepository.getMaintenanceStats(businessId),
          this.dashboardRepository.countVehiclesByType(businessId),
        ]);
      }

      // Get maintenance costs for last 6 months
      const maintenanceCosts = [];

      if (hasPermission("service_order_manage")) {
        for (let i = 5; i >= 0; i--) {
          let month = currentMonth - i;
          let year = currentYear;

          if (month < 0) {
            month += 12;
            year--;
          }

          const startDate = new Date(year, month, 1);
          const endDate = new Date(year, month + 1, 0);

          const costs = await this.dashboardRepository.getMonthlyCosts(
            {
              startDate: startDate.toISOString().split("T")[0],
              endDate: endDate.toISOString().split("T")[0],
            },
            businessId,
          );

          maintenanceCosts.push({
            month: monthNames[month],
            preventive: costs.preventive,
            corrective: costs.corrective,
          });
        }
      }

      // Get recent activities
      const recentActivityData =
        await this.activityRepository.listRecentActivities({
          page: 1,
          pageSize: 5,
          businessId,
          currentUserRole: user.role,
          userId: user.id,
        });

      const recentActivity = recentActivityData.data.map((activity: any) => ({
        id: activity.id,
        type: activity.type.charAt(0).toUpperCase() + activity.type.slice(1),
        description: activity.description,
        userEmail: activity.userEmail || "N/A",
        userName: activity.userName || "N/A",
        userRole: activity.userRole || "N/A",
        business_name: activity.business_name || "N/A",
        date: activity.created_at,
        status: activity.status,
      }));

      // Format the final response
      return {
        counts: {
          vehicles: counts.vehicle,
          drivers: counts.driver,
          businesses: counts.business,
          branches: counts.branch,
          parts: counts.part,
          suppliers: counts.supplier,
          serviceOrders: counts["service-order"],
          users: counts.user,
          fines: counts.fine,
        },
        vehicleStatus,
        activityTrends,
        maintenanceStats,
        recentActivity,
        vehiclesByType: vehiclesByType.data || [],
        maintenanceCosts,
      };
    } catch (error) {
      throw new AppError("Erro ao obter dados do dashboard", 500);
    }
  }
}

export { GetDashboardOverviewUseCase };
