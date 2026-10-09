import { inject, injectable } from "tsyringe";

import { IDashboardRepository } from "../../repositories/IDashboard-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IActivityRepository } from "@/modules/activity/repositories/IActivity-repository";
import {
  DashboardOverviewRequest,
  DashboardOverviewResponse,
} from "./dtos/get-dashboard-overview-dto";

import { IDeliveryRepository } from "@/modules/delivery/repositories/IDelivery-repository";
import type { IOperationDayRepository } from "@/modules/route/repositories/IOperation-day-repository";
import { readOperationSummary } from "@/modules/delivery/usecases/operation-summary/read-operation-summary";
import { getBusinessEntitlements } from "@/shared/entitlements/entitlement-service";
import { isModuleEnabled } from "@/shared/entitlements/entitlement-rules";

import { businessDateKey, businessMonthWindow } from "@/shared/time/business-day";
import { loadBusinessTimeZone } from "@/shared/time/business-time-zone";
import { operationDay } from "@/shared/route/operation-day-rules";

import { basisOf, currentMonthStart, samePointLastMonth } from "../shared/count-comparison";
import {
  DASHBOARD_ENTITIES,
  SERIES_KEY,
  canReadKey,
  monthLabel,
  visibleDashboardEntities,
  type DashboardModule,
} from "../shared/dashboard-entities";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";

/** Six trend months: the current one and the five before it. */
const TREND_MONTHS = 6;

@injectable()
class GetDashboardOverviewUseCase {
  constructor(
    @inject("UserRepository")
    private userRepository: IUserRepository,
    @inject("DashboardRepository")
    private dashboardRepository: IDashboardRepository,
    @inject("ActivityRepository")
    private activityRepository: IActivityRepository,
    @inject("DeliveryRepository")
    private deliveryRepository: IDeliveryRepository,
    @inject("BusinessRepository")
    private businessRepository: IBusinessRepository,
    @inject("OperationDayRepository")
    private operationDayRepository: IOperationDayRepository,
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

      const now = new Date();

      /**
       * Months, "this month" and "today" in the company's calendar
       * (`Business.timezone`), never the server's: the container runs in UTC,
       * so a row created at 22:00 on the last day of a month in São Paulo was
       * already next month's, and "today" reset at 21:00 (CRIT-8).
       */
      const timeZone = await loadBusinessTimeZone(
        this.businessRepository,
        businessId,
      );

      const months = businessMonthWindow(now, timeZone, TREND_MONTHS);
      const currentMonth = months.keys[TREND_MONTHS - 1];
      const lastMonth = months.keys[TREND_MONTHS - 2];

      /**
       * What this company hired. A MASTER has no single company, so there
       * is nothing to ask — their counts are global and stay that way.
       */
      const entitlements = businessId
        ? await getBusinessEntitlements(businessId)
        : null;

      const moduleEnabled = entitlements
        ? (module: DashboardModule) => isModuleEnabled(entitlements, module)
        : null;

      const deliveriesEnabled = moduleEnabled?.("DELIVERIES") ?? true;
      const fleetEnabled = moduleEnabled?.("FLEET") ?? true;

      const visible = visibleDashboardEntities(user, moduleEnabled);

      /**
       * Every number of this screen, for every visible entity, in ONE query.
       *
       * It used to be a loop: nine entities × (two cards + six trend months)
       * = 72 round trips, 89 queries measured for one page view. The window
       * covers both the cards and the trend.
       */
      const monthly = await this.dashboardRepository.countManyByMonth(
        {
          entities: visible.map((entity) => entity.key),
          from: months.start,
          to: months.end,
          timeZone,
        },
        businessId,
      );

      const byEntity = new Map<string, Map<string, number>>(
        Object.entries(monthly).map(([key, buckets]) => [
          key,
          new Map(buckets.map((bucket) => [bucket.month, bucket.count])),
        ]),
      );

      const countFor = (key: string, month: string): number =>
        byEntity.get(key)?.get(month) ?? 0;

      /**
       * What each card shows (count-comparison): a catalogue's total against
       * the total when the month began, an operation's month so far against
       * last month up to the same point. In sequence after the monthly
       * counts: one connection per page view.
       */
      const stocks = visible.filter((entity) => basisOf(entity.key) === "total");
      const flows = visible.filter((entity) => basisOf(entity.key) === "month_to_date");

      const totals = await this.dashboardRepository.countManyTotals(
        {
          entities: stocks.map((entity) => entity.key),
          before: currentMonthStart(now, timeZone),
        },
        businessId,
      );

      const lastSpan = samePointLastMonth(now, timeZone);
      const lastSpanCounts =
        flows.length > 0
          ? await this.dashboardRepository.countManyByPeriod(
              {
                entities: flows.map((entity) => entity.key),
                from: lastSpan.from,
                to: lastSpan.to,
                granularity: "month",
                timeZone,
              },
              businessId,
            )
          : {};

      const spanFor = (key: string): number =>
        (lastSpanCounts[key] ?? []).reduce((sum, bucket) => sum + bucket.count, 0);

      const counts = Object.fromEntries(
        DASHBOARD_ENTITIES.map((entity) => {
          const basis = basisOf(entity.key);

          // A hidden entity answers zero (it was never queried): the cards
          // are gated by the web's route registry, and the zero keeps the
          // documented shape.
          return [
            SERIES_KEY[entity.key],
            {
              currentMonth: countFor(entity.key, currentMonth),
              lastMonth: countFor(entity.key, lastMonth),
              basis,
              value:
                basis === "total"
                  ? (totals[entity.key]?.total ?? 0)
                  : countFor(entity.key, currentMonth),
              previous:
                basis === "total"
                  ? (totals[entity.key]?.before ?? 0)
                  : spanFor(entity.key),
            },
          ];
        }),
      ) as DashboardOverviewResponse["counts"];

      /**
       * The trend carries ONLY the visible series (DLVP-ADM-1). A hidden one
       * sent as zero drew a flat "Entregas" line for a company that never
       * hired the module; the chart draws a line per key it receives.
       */
      const activityTrends = months.keys.map((month) => {
        const point: Record<string, string | number> = { month: monthLabel(month) };

        for (const entity of visible) {
          point[SERIES_KEY[entity.key]] = countFor(entity.key, month);
        }

        return point;
      }) as DashboardOverviewResponse["activityTrends"];

      let vehicleStatus = { ACTIVE: 0, INACTIVE: 0, BLOCKED: 0, IN_ROUTE: 0 };
      let maintenanceStats = { pending: 0, recent: 0, overdue: 0 };

      let vehiclesByType: Awaited<
        ReturnType<IDashboardRepository["countVehiclesByType"]>
      > = { data: [] };

      if (canReadKey(user, "vehicle_manage")) {
        // In sequence, for the same reason as the monthly counts above: one
        // page view holds one connection, never a handful at once.
        vehicleStatus =
          await this.dashboardRepository.countVehiclesByStatus(businessId);

        // Maintenance planning is Frotas; the vehicles themselves are not.
        // Due days are the company's civil days, checked against its today.
        if (fleetEnabled) {
          maintenanceStats = await this.dashboardRepository.getMaintenanceStats(
            { today: businessDateKey(now, timeZone), timeZone },
            businessId,
          );
        }

        vehiclesByType =
          await this.dashboardRepository.countVehiclesByType(businessId);
      }

      const maintenanceCosts: DashboardOverviewResponse["maintenanceCosts"] = [];

      // Service orders are Frotas: no costs without the module (DASH-MOD-1).
      if (fleetEnabled && canReadKey(user, "service_order_manage")) {
        const costBuckets = await this.dashboardRepository.getCostsByMonth(
          { from: months.start, to: months.end, timeZone },
          businessId,
        );

        const costsByMonth = new Map(
          costBuckets.map((bucket) => [bucket.month, bucket]),
        );

        for (const month of months.keys) {
          const bucket = costsByMonth.get(month);

          maintenanceCosts.push({
            month: monthLabel(month),

            // Zero for a month with no work, not an absent key: the chart
            // draws a bar either way and "undefined" is not a number.
            internal: bucket?.internal ?? 0,
            external: bucket?.external ?? 0,
          });
        }
      }

      /**
       * The operation as it stands, for the company this user works in.
       *
       * Deliberately the same read the monitoring panel makes, on the
       * tower's documents of the company's business day (decision 7.1): two
       * queries that are supposed to agree and are written twice eventually
       * disagree.
       *
       * Null in three cases, each for its own reason — no company to
       * summarise (MASTER), the module was never hired, or this profile may
       * not read deliveries. A driver never reaches here: the route is a
       * manager surface.
       */
      let deliveryOperation: DashboardOverviewResponse["deliveryOperation"] =
        null;

      if (
        businessId &&
        deliveriesEnabled &&
        !user.driverId &&
        canReadKey(user, "delivery_manage")
      ) {
        const summary = await readOperationSummary(
          {
            operation: this.operationDayRepository,
            delivery: this.deliveryRepository,
          },
          businessId,
          operationDay(timeZone, now),
        );

        deliveryOperation = summary.totals;
      }

      // The five newest lines, without a total: this screen has no pager,
      // and the paginated listing's COUNT walked the whole activity trail
      // (the whole table for a MASTER) only to be discarded here.
      const recentActivity =
        await this.activityRepository.listRecentActivitiesPreview({
          take: 5,
          businessId,
          currentUserRole: user.role,
          userId: user.id,
        });

      return {
        counts,
        vehicleStatus,
        activityTrends,
        maintenanceStats,
        deliveryOperation,
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
