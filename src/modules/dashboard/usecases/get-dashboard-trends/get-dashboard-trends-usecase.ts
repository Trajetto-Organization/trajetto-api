import { inject, injectable } from "tsyringe";

import { IDashboardRepository } from "../../repositories/IDashboard-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { getBusinessEntitlements } from "@/shared/entitlements/entitlement-service";
import { isModuleEnabled } from "@/shared/entitlements/entitlement-rules";

import {
  businessDayWindow,
  businessMonthWindow,
  dateOnlyFromKey,
  type BusinessWindow,
} from "@/shared/time/business-day";
import { loadBusinessTimeZone } from "@/shared/time/business-time-zone";

import {
  SERIES_KEY,
  canReadKey,
  monthLabel,
  visibleDashboardEntities,
  type DashboardModule,
} from "../shared/dashboard-entities";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";

type TrendsPeriod = "7d" | "30d" | "3m" | "6m" | "12m";

interface GetDashboardTrendsRequest {
  userId: string;
  period: TrendsPeriod;
}

/**
 * One point per bucket. A series is present only when the viewer may see it
 * and the company hired its module (DLVP-ADM-1): the chart draws one line per
 * key it receives, so a hidden series sent as zero was a flat line.
 */
type TrendPoint = Record<string, string | number> & { date: string };

interface DashboardTrendsResponse {
  activityTrends: TrendPoint[];
  maintenanceCosts: Array<{
    date: string;
    internal: number;
    external: number;
  }>;
}

/**
 * The buckets of a period, in the company's calendar. Days for 7 and 30;
 * months otherwise, the current one plus N before it (the same number of
 * points the chart always drew).
 */
function windowFor(
  period: TrendsPeriod,
  now: Date,
  timeZone: string,
): { granularity: "day" | "month"; window: BusinessWindow } {
  switch (period) {
    case "7d":
      return {
        granularity: "day",
        window: businessDayWindow(now, timeZone, 7),
      };
    case "30d":
      return {
        granularity: "day",
        window: businessDayWindow(now, timeZone, 30),
      };
    case "3m":
      return {
        granularity: "month",
        window: businessMonthWindow(now, timeZone, 4),
      };
    case "6m":
      return {
        granularity: "month",
        window: businessMonthWindow(now, timeZone, 7),
      };
    case "12m":
      return {
        granularity: "month",
        window: businessMonthWindow(now, timeZone, 13),
      };
  }
}

/**
 * The label under a point: "27 de set." for a civil day (read in UTC — the
 * key is a calendar day, not an instant), "Set" for a month.
 */
function labelFor(key: string, granularity: "day" | "month"): string {
  return granularity === "day"
    ? dateOnlyFromKey(key).toLocaleDateString("pt-BR", {
        day: "2-digit",
        month: "short",
        timeZone: "UTC",
      })
    : monthLabel(key);
}

@injectable()
class GetDashboardTrendsUseCase {
  constructor(
    @inject("UserRepository")
    private userRepository: IUserRepository,
    @inject("DashboardRepository")
    private dashboardRepository: IDashboardRepository,
    @inject("BusinessRepository")
    private businessRepository: IBusinessRepository,
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

      // Days and months of the company's calendar, never the server's
      // (the container runs in UTC; see shared/time/business-day).
      const timeZone = await loadBusinessTimeZone(
        this.businessRepository,
        businessId,
      );

      const { granularity, window } = windowFor(period, new Date(), timeZone);

      // Same rule as the overview: a MASTER has no single company to ask.
      const entitlements = businessId
        ? await getBusinessEntitlements(businessId)
        : null;

      const moduleEnabled = entitlements
        ? (module: DashboardModule) => isModuleEnabled(entitlements, module)
        : null;

      const visible = visibleDashboardEntities(user, moduleEnabled);

      /**
       * Every bucket of every entity, in ONE round trip. Then the costs, in a
       * second.
       *
       * This used to be a loop: for each day in the window, nine counts in
       * parallel plus one cost query. Thirty days is 300 round trips to draw
       * one chart. Two queries, one connection at a time, identical numbers.
       */
      const buckets = await this.dashboardRepository.countManyByPeriod(
        {
          entities: visible.map((entity) => entity.key),
          from: window.start,
          to: window.end,
          granularity,
          timeZone,
        },
        businessId,
      );

      const byEntity = new Map<string, Map<string, number>>(
        Object.entries(buckets).map(([key, rows]) => [
          key,
          new Map(rows.map((row) => [row.period, row.count])),
        ]),
      );

      // Service orders are Frotas: no costs without the module (DASH-MOD-1).
      const showCosts =
        (moduleEnabled?.("FLEET") ?? true) &&
        canReadKey(user, "service_order_manage");

      const costBuckets = showCosts
        ? await this.dashboardRepository.getCostsByPeriod(
            { from: window.start, to: window.end, granularity, timeZone },
            businessId,
          )
        : [];

      const costsByPeriod = new Map(
        costBuckets.map((bucket) => [bucket.period, bucket]),
      );

      const activityTrends: TrendPoint[] = [];
      const maintenanceCosts: DashboardTrendsResponse["maintenanceCosts"] = [];

      for (const key of window.keys) {
        const label = labelFor(key, granularity);
        const point: TrendPoint = { date: label };

        for (const entity of visible) {
          point[SERIES_KEY[entity.key]] =
            byEntity.get(entity.key)?.get(key) ?? 0;
        }

        activityTrends.push(point);

        if (showCosts) {
          const bucket = costsByPeriod.get(key);

          maintenanceCosts.push({
            date: label,
            internal: bucket?.internal ?? 0,
            external: bucket?.external ?? 0,
          });
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
