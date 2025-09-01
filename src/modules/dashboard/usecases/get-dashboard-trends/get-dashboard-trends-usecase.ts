import { inject, injectable } from "tsyringe";

import { IDashboardRepository } from "../../repositories/IDashboard-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";

interface GetDashboardTrendsRequest {
  userId: string;
  period: "7d" | "30d" | "3m" | "6m" | "12m";
}

interface DashboardTrendsResponse {
  activityTrends: Array<{
    date: string;
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
  maintenanceCosts: Array<{
    date: string;
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

  if (pluralMap[key]) {
    return pluralMap[key];
  }

  return key + "s";
};

const formatDateToLocal = (date: Date): string => {
  return date.toISOString().split("T")[0];
};

const getCurrentDateLocal = (): Date => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
};

@injectable()
class GetDashboardTrendsUseCase {
  constructor(
    @inject("UserRepository")
    private userRepository: IUserRepository,
    @inject("DashboardRepository")
    private dashboardRepository: IDashboardRepository,
  ) {}

  async execute({
    userId,
    period,
  }: GetDashboardTrendsRequest): Promise<DashboardTrendsResponse> {
    const user = await this.userRepository.findUserById(userId);

    if (!user) {
      throw new ResourceNotFoundError();
    }

    try {
      const businessId =
        user.role !== "MASTER" ? (user.businessId as string) : undefined;

      const endDateLocal = getCurrentDateLocal();
      let startDateLocal = new Date(endDateLocal);

      let groupBy: "day" | "month" = "day";

      switch (period) {
        case "7d":
          startDateLocal = new Date(endDateLocal);
          startDateLocal.setDate(endDateLocal.getDate() - 6);

          groupBy = "day";
          break;
        case "30d":
          startDateLocal = new Date(endDateLocal);
          startDateLocal.setDate(endDateLocal.getDate() - 29);

          groupBy = "day";
          break;
        case "3m":
          startDateLocal = new Date(endDateLocal);
          startDateLocal.setMonth(endDateLocal.getMonth() - 3);

          groupBy = "month";
          break;
        case "6m":
          startDateLocal = new Date(endDateLocal);
          startDateLocal.setMonth(endDateLocal.getMonth() - 6);

          groupBy = "month";
          break;
        case "12m":
          startDateLocal = new Date(endDateLocal);
          startDateLocal.setFullYear(endDateLocal.getFullYear() - 1);

          groupBy = "month";
          break;
      }

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

      const activityTrends: any[] = [];
      const maintenanceCosts: any[] = [];

      if (groupBy === "day") {
        const currentDateLocal = new Date(startDateLocal);

        while (currentDateLocal <= endDateLocal) {
          const trendData: any = {
            date: currentDateLocal.toLocaleDateString("pt-BR", {
              day: "2-digit",
              month: "short",
            }),
          };

          const dayPromises = entities.map(async (entity) => {
            if (
              (user.role === "BUSINESS_ADMIN" && entity.key === "business") ||
              !hasPermission(entity.permission)
            ) {
              return { key: entity.key, count: 0 };
            }

            const result = await this.dashboardRepository.countByDateRange(
              {
                entity: entity.key as any,
                startDate: formatDateToLocal(currentDateLocal),
                endDate: formatDateToLocal(currentDateLocal),
              },
              businessId,
            );

            return { key: entity.key, count: result.count };
          });

          const dayResults = await Promise.all(dayPromises);

          dayResults.forEach(({ key, count }) => {
            const fieldName = pluralizeFieldName(key);
            trendData[fieldName] = count;
          });

          activityTrends.push(trendData);

          if (hasPermission("service_order_manage")) {
            const costs = await this.dashboardRepository.getMonthlyCosts(
              {
                startDate: formatDateToLocal(currentDateLocal),
                endDate: formatDateToLocal(currentDateLocal),
              },
              businessId,
            );

            maintenanceCosts.push({
              date: trendData.date,
              preventive: costs.preventive,
              corrective: costs.corrective,
            });
          }

          currentDateLocal.setDate(currentDateLocal.getDate() + 1);
        }
      } else {
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

        const currentDateLocal = new Date(startDateLocal);
        currentDateLocal.setDate(1);

        while (currentDateLocal <= endDateLocal) {
          const monthStart = new Date(
            currentDateLocal.getFullYear(),
            currentDateLocal.getMonth(),
            1,
          );

          const monthEnd = new Date(
            currentDateLocal.getFullYear(),
            currentDateLocal.getMonth() + 1,
            0,
          );

          const trendData: any = {
            date: monthNames[currentDateLocal.getMonth()],
          };

          const monthPromises = entities.map(async (entity) => {
            if (
              (user.role === "BUSINESS_ADMIN" && entity.key === "business") ||
              !hasPermission(entity.permission)
            ) {
              return { key: entity.key, count: 0 };
            }

            const result = await this.dashboardRepository.countByDateRange(
              {
                entity: entity.key as any,
                startDate: formatDateToLocal(monthStart),
                endDate: formatDateToLocal(monthEnd),
              },
              businessId,
            );

            return { key: entity.key, count: result.count };
          });

          const monthResults = await Promise.all(monthPromises);

          monthResults.forEach(({ key, count }) => {
            const fieldName = pluralizeFieldName(key);
            trendData[fieldName] = count;
          });

          activityTrends.push(trendData);

          if (hasPermission("service_order_manage")) {
            const costs = await this.dashboardRepository.getMonthlyCosts(
              {
                startDate: formatDateToLocal(monthStart),
                endDate: formatDateToLocal(monthEnd),
              },
              businessId,
            );

            maintenanceCosts.push({
              date: trendData.date,
              preventive: costs.preventive,
              corrective: costs.corrective,
            });
          }

          currentDateLocal.setMonth(currentDateLocal.getMonth() + 1);
        }
      }

      return {
        activityTrends,
        maintenanceCosts,
      };
    } catch (error) {
      throw new AppError("Erro ao obter tendências do dashboard", 500);
    }
  }
}

export { GetDashboardTrendsUseCase };
