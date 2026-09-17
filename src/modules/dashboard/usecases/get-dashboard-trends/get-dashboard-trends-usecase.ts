import { inject, injectable } from "tsyringe";

import { IDashboardRepository } from "../../repositories/IDashboard-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { hasModule } from "@/shared/entitlements/entitlement-service";

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
    deliveries: number;
    routes: number;
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

    // "deliverys" is what the default rule produces, and the chart keys off
    // these names — a wrong one draws a line of undefined.
    delivery: "deliveries",
  };

  if (pluralMap[key]) {
    return pluralMap[key];
  }

  return key + "s";
};

/**
 * The grouping key, in local wall time.
 *
 * Must match what the repository's `to_char(date_trunc(...))` produces, or
 * every lookup misses and the chart draws a flat line of zeroes over a
 * database full of rows.
 */
const periodKey = (at: Date, granularity: "day" | "month"): string => {
  const year = at.getFullYear();
  const month = String(at.getMonth() + 1).padStart(2, "0");

  if (granularity === "month") return `${year}-${month}`;

  return `${year}-${month}-${String(at.getDate()).padStart(2, "0")}`;
};

/**
 * The last instant of the window's final bucket.
 *
 * `endDateLocal` is midnight, and the query filters `created_at <= to`, so
 * without this every row created DURING the last day would be dropped — the
 * day people are actually looking at.
 *
 * It follows the granularity, because the last bucket is a different size in
 * each case. On a monthly chart the final point is the current month, and it
 * has to include the rest of that month exactly as the old per-bucket loop
 * did with `new Date(year, month + 1, 0)`.
 */
const endOfWindow = (
  endDateLocal: Date,
  granularity: "day" | "month",
): Date => {
  const end = new Date(endDateLocal);

  if (granularity === "month") {
    end.setMonth(end.getMonth() + 1, 0);
  }

  end.setHours(23, 59, 59, 999);

  return end;
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
        { key: "delivery", permission: "delivery_manage" },
        { key: "route", permission: "delivery_manage" },
      ];

      /**
       * Whether this company hired the deliveries module.
       *
       * Same rule as the overview, and for the same reason: a permission is
       * what a PERSON may do, an entitlement is what the company bought, and
       * a BUSINESS_ADMIN passes every permission check by definition.
       */
      const deliveriesEnabled = businessId
        ? await hasModule(businessId, "DELIVERIES")
        : true;

      const visible = entities.filter((entity) => {
        if (user.role === "BUSINESS_ADMIN" && entity.key === "business") {
          return false;
        }

        if (
          !deliveriesEnabled &&
          (entity.key === "delivery" || entity.key === "route")
        ) {
          return false;
        }

        return hasPermission(entity.permission);
      });

      /**
       * Every bucket of every entity, in ONE round trip. Then the costs, in a
       * second.
       *
       * This used to be a loop: for each day in the window, nine counts in
       * parallel plus one cost query. Thirty days is 300 round trips to draw
       * one chart, and the nine-at-a-time parallelism made it worse rather
       * than better — the overview already learned that lesson, where nine
       * concurrent connections per page view starved the pool and made the
       * p95 of the whole API fifteen times worse.
       *
       * Two queries, one connection at a time, identical numbers.
       */
      const buckets = await this.dashboardRepository.countManyByPeriod(
        {
          entities: visible.map((entity) => entity.key as any),
          from: startDateLocal,
          to: endOfWindow(endDateLocal, groupBy),
          granularity: groupBy,
        },
        businessId,
      );

      const byEntity = new Map<string, Map<string, number>>(
        Object.entries(buckets).map(([key, rows]) => [
          key,
          new Map(rows.map((row) => [row.period, row.count])),
        ]),
      );

      const countFor = (key: string, at: Date): number =>
        byEntity.get(key)?.get(periodKey(at, groupBy)) ?? 0;

      const costBuckets = hasPermission("service_order_manage")
        ? await this.dashboardRepository.getCostsByPeriod(
            {
              from: startDateLocal,
              to: endOfWindow(endDateLocal, groupBy),
              granularity: groupBy,
            },
            businessId,
          )
        : [];

      const costsByPeriod = new Map(
        costBuckets.map((bucket) => [bucket.period, bucket]),
      );

      const activityTrends: any[] = [];
      const maintenanceCosts: any[] = [];

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

      /** The label the chart puts under a point. Unchanged from before. */
      const labelFor = (at: Date): string =>
        groupBy === "day"
          ? at.toLocaleDateString("pt-BR", { day: "2-digit", month: "short" })
          : monthNames[at.getMonth()];

      const cursor = new Date(startDateLocal);

      // The monthly branch always started on the first of the month.
      if (groupBy === "month") cursor.setDate(1);

      while (cursor <= endDateLocal) {
        const label = labelFor(cursor);

        const trendData: any = { date: label };

        // EVERY entity, not only the visible ones: a hidden entity answers
        // zero rather than being absent, because the chart draws a line for
        // it either way and "undefined" is not a number.
        for (const entity of entities) {
          trendData[pluralizeFieldName(entity.key)] = countFor(
            entity.key,
            cursor,
          );
        }

        activityTrends.push(trendData);

        if (hasPermission("service_order_manage")) {
          const bucket = costsByPeriod.get(periodKey(cursor, groupBy));

          maintenanceCosts.push({
            date: label,
            preventive: bucket?.preventive ?? 0,
            corrective: bucket?.corrective ?? 0,
          });
        }

        if (groupBy === "day") {
          cursor.setDate(cursor.getDate() + 1);
        } else {
          cursor.setMonth(cursor.getMonth() + 1);
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
