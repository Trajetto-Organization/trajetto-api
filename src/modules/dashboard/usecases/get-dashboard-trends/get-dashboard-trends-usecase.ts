import { inject, injectable } from "tsyringe";

import { IDashboardRepository } from "../../repositories/IDashboard-repository";
import type { DashboardEntity } from "../../dtos/dashboard-dto";
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
import {
  dashboardRollupMode,
  deliveriesFromRollup,
  readWithRollup,
  shadowDeliveryRollup,
} from "../shared/delivery-rollup";
import {
  readDashboardNumbers,
  trendsVariant,
  type TrendsVisibility,
} from "../shared/dashboard-snapshot";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";
import type { TenantSnapshot } from "@/shared/cache/tenant-snapshot";

type TrendsPeriod = "7d" | "30d" | "3m" | "6m" | "12m";

interface GetDashboardTrendsRequest {
  userId: string;
  period: TrendsPeriod;

  /**
   * The company's modules, when the session lookup of this request already
   * loaded them (request.user.entitlements), as the overview takes them.
   * Absent or null, they are read.
   */
  entitlements?: Array<{ module: string; enabled: boolean }> | null;

  /** The panel's "Atualizar" (`x-trajetto-refresh: 1`), as the overview. */
  refresh?: boolean;
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
    /**
     * A company's chart, kept a minute per company, period and visibility
     * in this process (F4-23, DASHBOARD_SNAPSHOT_TTL_MS; registered in
     * src/shared/index.ts). Absent, every view reads it.
     */
    @inject("DashboardTrendsSnapshots")
    private companySnapshots?: TenantSnapshot<DashboardTrendsResponse>,
  ) {}

  async execute({
    userId,
    period,
    entitlements: sessionEntitlements,
    refresh = false,
  }: GetDashboardTrendsRequest): Promise<DashboardTrendsResponse> {
    const user = await this.userRepository.findUserById(userId);

    if (!user) {
      throw new ResourceNotFoundError();
    }

    try {
      const businessId =
        user.role !== "MASTER" ? (user.businessId as string) : undefined;

      /**
       * Days and months of the company's calendar, never the server's (the
       * container runs in UTC; see shared/time/business-day). And the same
       * rule as the overview for the modules: a MASTER has no single
       * company to ask, and the session already brought them.
       */
      const [timeZone, entitlements] = await Promise.all([
        loadBusinessTimeZone(this.businessRepository, businessId),
        businessId
          ? (sessionEntitlements ?? getBusinessEntitlements(businessId))
          : null,
      ]);

      const moduleEnabled = entitlements
        ? (module: DashboardModule) => isModuleEnabled(entitlements, module)
        : null;

      /**
       * What the chart shows this viewer, and so what tells two copies of
       * a company's chart apart (F4-23): the series it may see, and the
       * costs, which are Frotas (DASH-MOD-1) and service orders.
       */
      const visibility: TrendsVisibility = {
        entities: visibleDashboardEntities(user, moduleEnabled).map(
          (entity) => entity.key,
        ),
        costs:
          (moduleEnabled?.("FLEET") ?? true) &&
          canReadKey(user, "service_order_manage"),
      };

      return await readDashboardNumbers(this.companySnapshots, {
        businessId,
        variant: trendsVariant(period, visibility, timeZone),
        compute: () => this.trendsFor(businessId, period, visibility, timeZone),
        refresh,
      });
    } catch (error) {
      throw new AppError("Erro ao obter tendências do dashboard", 500);
    }
  }

  /**
   * The chart of a company (every company, for the MASTER) as a visibility
   * shows it. Nothing here may depend on who asks: two viewers with the
   * same visibility are handed one computation's chart.
   */
  private async trendsFor(
    businessId: string | undefined,
    period: TrendsPeriod,
    visibility: TrendsVisibility,
    timeZone: string,
  ): Promise<DashboardTrendsResponse> {
    const now = new Date();
    const { granularity, window } = windowFor(period, now, timeZone);

    const visible: readonly DashboardEntity[] = visibility.entities;

    // The "Entregas" series from the closed days with "on", live and
    // compared on the side with "shadow" (plano-escala F4-22).
    const rollupMode = dashboardRollupMode();
    const showsDeliveries = visible.includes("delivery");

    /**
     * Every bucket of every entity, in ONE round trip. Then the costs, in a
     * second.
     *
     * This used to be a loop: for each day in the window, nine counts in
     * parallel plus one cost query. Thirty days is 300 round trips to draw
     * one chart. Two queries, one connection at a time, identical numbers.
     */
    const buckets = await readWithRollup(
      deliveriesFromRollup(rollupMode, showsDeliveries, now),
      (deliveries) =>
        this.dashboardRepository.countManyByPeriod(
          {
            entities: [...visible],
            from: window.start,
            to: window.end,
            granularity,
            timeZone,
            deliveriesFromRollup: deliveries,
          },
          businessId,
        ),
      "trends",
    );

    if (rollupMode === "shadow" && showsDeliveries) {
      shadowDeliveryRollup({
        repository: this.dashboardRepository,
        screen: "trends",
        businessId,
        timeZone,
        now,
        windows: [
          {
            from: window.start,
            to: window.end,
            granularity,
            served: buckets.delivery ?? [],
          },
        ],
      });
    }

    const byEntity = new Map<string, Map<string, number>>(
      Object.entries(buckets).map(([key, rows]) => [
        key,
        new Map(rows.map((row) => [row.period, row.count])),
      ]),
    );

    const costBuckets = visibility.costs
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
        point[SERIES_KEY[entity]] = byEntity.get(entity)?.get(key) ?? 0;
      }

      activityTrends.push(point);

      if (visibility.costs) {
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
  }
}

export { GetDashboardTrendsUseCase, type DashboardTrendsResponse };
