import { inject, injectable } from "tsyringe";

import { IDashboardRepository } from "../../repositories/IDashboard-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { IActivityRepository } from "@/modules/activity/repositories/IActivity-repository";
import {
  DashboardOverviewRequest,
  DashboardOverviewResponse,
} from "./dtos/get-dashboard-overview-dto";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";

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

      /**
       * Every number this screen shows, for every entity, in ONE query each.
       *
       * It used to be a loop: nine entities × (two cards + six trend months)
       * = 72 round trips, which made the dashboard the heaviest read in the
       * product by an order of magnitude — 89 queries measured for one page
       * view. The window below covers both the cards and the trend, so the
       * same nine results answer everything.
       */
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

      const currentMonth = now.getMonth();
      const currentYear = now.getFullYear();

      // Six trend months back, and the current month forward. `lastMonthStart`
      // is inside that window, so nothing needs a second pass.
      const windowStart = new Date(currentYear, currentMonth - 5, 1);
      const windowEnd = currentMonthEnd;

      const visible = entities.filter(
        (entity) =>
          !(user.role === "BUSINESS_ADMIN" && entity.key === "business") &&
          hasPermission(entity.permission),
      );

      // ONE round trip for all of them. Nine in parallel was the first
      // attempt, and it held nine connections per page view — the pool
      // starved and the p95 of the whole API got fifteen times worse while
      // the median improved.
      const monthly = await this.dashboardRepository.countManyByMonth(
        {
          entities: visible.map((entity) => entity.key as any),
          from: windowStart,
          to: windowEnd,
        },
        businessId,
      );

      /** `YYYY-MM` for a Date, in the server's timezone — the grouping basis. */
      const monthKey = (at: Date): string =>
        `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}`;

      const byEntity = new Map<string, Map<string, number>>(
        Object.entries(monthly).map(([key, buckets]) => [
          key,
          new Map(buckets.map((bucket) => [bucket.month, bucket.count])),
        ]),
      );

      const countFor = (key: string, at: Date): number =>
        byEntity.get(key)?.get(monthKey(at)) ?? 0;

      const counts: any = {};

      for (const entity of entities) {
        counts[entity.key] = {
          // A hidden entity answers zero rather than being absent: the card
          // exists on the screen either way, and an absent key renders as
          // "undefined" where a number belongs.
          currentMonth: countFor(entity.key, currentMonthStart),
          lastMonth: countFor(entity.key, lastMonthStart),
        };
      }

      // The trend, read out of the same nine results. No further queries.
      const activityTrends = [];

      for (let i = 5; i >= 0; i--) {
        const at = new Date(currentYear, currentMonth - i, 1);

        const monthData: any = { month: monthNames[at.getMonth()] };

        for (const entity of entities) {
          monthData[pluralizeFieldName(entity.key)] = countFor(entity.key, at);
        }

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
        // One query for the six months, summed in the database. It used to be
        // six queries, each returning every service order row of its month to
        // be added up here.
        const costBuckets = await this.dashboardRepository.getCostsByMonth(
          { from: windowStart, to: windowEnd },
          businessId,
        );

        const costsByMonth = new Map(
          costBuckets.map((bucket) => [bucket.month, bucket]),
        );

        for (let i = 5; i >= 0; i--) {
          const at = new Date(currentYear, currentMonth - i, 1);
          const bucket = costsByMonth.get(monthKey(at));

          maintenanceCosts.push({
            month: monthNames[at.getMonth()],

            // Zero for a month with no work, not an absent key: the chart
            // draws a bar either way and "undefined" is not a number.
            preventive: bucket?.preventive ?? 0,
            corrective: bucket?.corrective ?? 0,
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
        recentActivity: recentActivityData.data,
        vehiclesByType: vehiclesByType.data || [],
        maintenanceCosts,
      };
    } catch (error) {
      throw new AppError("Erro ao obter dados do dashboard", 500);
    }
  }
}

export { GetDashboardOverviewUseCase };
