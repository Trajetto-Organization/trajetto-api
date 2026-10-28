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

import {
  businessDateKey,
  businessMonthWindow,
} from "@/shared/time/business-day";
import { loadBusinessTimeZone } from "@/shared/time/business-time-zone";
import { operationDay } from "@/shared/route/operation-day-rules";

import {
  basisOf,
  currentMonthStart,
  samePointLastMonth,
} from "../shared/count-comparison";
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
import { boundedAll } from "@/shared/utils/bounded-all";
import type { SnapshotCache } from "@/shared/cache/snapshot-cache";

/** Six trend months: the current one and the five before it. */
const TREND_MONTHS = 6;

/**
 * Independent reads in flight at once: two, the budget every screen keeps
 * (tests/E2E/connection-fan-out.test.ts). Eleven reads one after the other
 * cost eleven round trips; all at once they took as many of the replica's
 * ten connections, and nine parallel counts once made the API's p95 fifteen
 * times worse. Two lanes keep the pool to everybody else.
 */
const OVERVIEW_READ_LANES = 2;

/** How long the MASTER's platform-wide overview is served before a new read. */
const MASTER_OVERVIEW_TTL_MS = 60 * 1000;

/** Everything but the activity feed, which is read fresh on every view. */
type OverviewNumbers = Omit<DashboardOverviewResponse, "recentActivity">;

type Viewer = NonNullable<Awaited<ReturnType<IUserRepository["findUserById"]>>>;

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
    /**
     * The MASTER's platform-wide numbers, shared for a minute (registered in
     * src/shared/index.ts). Absent — the suites that build the use case by
     * hand — every view reads them.
     */
    @inject("MasterOverviewSnapshots")
    private masterSnapshots?: SnapshotCache<OverviewNumbers>,
  ) {}

  async execute({
    userId,
    entitlements,
  }: DashboardOverviewRequest): Promise<DashboardOverviewResponse> {
    const user = await this.userRepository.findUserById(userId);

    if (!user) {
      throw new ResourceNotFoundError();
    }

    try {
      const businessId =
        user.role !== "MASTER" ? (user.businessId as string) : undefined;

      /**
       * The MASTER sees the platform: every count is over every company, the
       * same numbers for every MASTER (no company, no profile — canReadKey
       * passes them all). Those counts are the heaviest reads of the screen
       * and grow with the whole platform, so they are computed once a minute
       * and shared by the replicas (snapshot-cache.ts). Only aggregates go
       * in: the activity feed, which names people, is read per view below.
       */
      const numbers =
        user.role === "MASTER" && this.masterSnapshots
          ? (
              await this.masterSnapshots.read({
                compute: () => this.numbersFor(user, undefined, null),
              })
            ).value
          : await this.numbersFor(user, businessId, entitlements ?? null);

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

      return { ...numbers, recentActivity };
    } catch (error) {
      throw new AppError("Erro ao obter dados do dashboard", 500);
    }
  }

  private async numbersFor(
    user: Viewer,
    businessId: string | undefined,
    sessionEntitlements: DashboardOverviewRequest["entitlements"] | null,
  ): Promise<OverviewNumbers> {
    const now = new Date();

    /**
     * Months, "this month" and "today" in the company's calendar
     * (`Business.timezone`), never the server's: the container runs in UTC,
     * so a row created at 22:00 on the last day of a month in São Paulo was
     * already next month's, and "today" reset at 21:00 (CRIT-8).
     *
     * And what this company hired. A MASTER has no single company, so there
     * is nothing to ask — their counts are global and stay that way. The
     * session lookup of this request already loaded the modules
     * (request.user.entitlements); they are read again only without it.
     */
    const [timeZone, entitlements] = await Promise.all([
      loadBusinessTimeZone(this.businessRepository, businessId),
      businessId
        ? (sessionEntitlements ?? getBusinessEntitlements(businessId))
        : null,
    ]);

    const months = businessMonthWindow(now, timeZone, TREND_MONTHS);
    const currentMonth = months.keys[TREND_MONTHS - 1];
    const lastMonth = months.keys[TREND_MONTHS - 2];

    const moduleEnabled = entitlements
      ? (module: DashboardModule) => isModuleEnabled(entitlements, module)
      : null;

    const deliveriesEnabled = moduleEnabled?.("DELIVERIES") ?? true;
    const fleetEnabled = moduleEnabled?.("FLEET") ?? true;

    const visible = visibleDashboardEntities(user, moduleEnabled);

    /**
     * What each card shows (count-comparison): a catalogue's total against
     * the total when the month began, an operation's month so far against
     * last month up to the same point.
     */
    const stocks = visible.filter((entity) => basisOf(entity.key) === "total");
    const flows = visible.filter(
      (entity) => basisOf(entity.key) === "month_to_date",
    );

    const lastSpan = samePointLastMonth(now, timeZone);

    const readsVehicles = canReadKey(user, "vehicle_manage");
    const readsCosts = fleetEnabled && canReadKey(user, "service_order_manage");

    /**
     * The operation as it stands, for the company this user works in.
     *
     * Deliberately the same read the monitoring panel makes, on the tower's
     * documents of the company's business day (decision 7.1): two queries
     * that are supposed to agree and are written twice eventually disagree.
     *
     * Null in three cases, each for its own reason — no company to summarise
     * (MASTER), the module was never hired, or this profile may not read
     * deliveries. A driver never reaches here: the route is a manager surface.
     */
    const readsOperation =
      Boolean(businessId) &&
      deliveriesEnabled &&
      !user.driverId &&
      canReadKey(user, "delivery_manage");

    /**
     * Every independent read of the screen, two at a time (see
     * OVERVIEW_READ_LANES). Each one is a single query or a short sequence,
     * never a fan-out of its own, so two lanes are two connections at most.
     *
     * The monthly counts are every number of every visible entity in ONE
     * query: it used to be a loop of 72 round trips (nine entities × two
     * cards + six trend months), 89 queries measured for one page view.
     */
    const [
      monthly,
      totals,
      lastSpanCounts,
      vehicleStatus,
      maintenanceStats,
      vehiclesByType,
      costBuckets,
      operationSummary,
    ] = await boundedAll(OVERVIEW_READ_LANES, [
      () =>
        this.dashboardRepository.countManyByMonth(
          {
            entities: visible.map((entity) => entity.key),
            from: months.start,
            to: months.end,
            timeZone,
          },
          businessId,
        ),
      () =>
        this.dashboardRepository.countManyTotals(
          {
            entities: stocks.map((entity) => entity.key),
            before: currentMonthStart(now, timeZone),
          },
          businessId,
        ),
      async () =>
        flows.length > 0
          ? this.dashboardRepository.countManyByPeriod(
              {
                entities: flows.map((entity) => entity.key),
                from: lastSpan.from,
                to: lastSpan.to,
                granularity: "month",
                timeZone,
              },
              businessId,
            )
          : {},
      async () =>
        readsVehicles
          ? this.dashboardRepository.countVehiclesByStatus(businessId)
          : { ACTIVE: 0, INACTIVE: 0, BLOCKED: 0, IN_ROUTE: 0 },
      // Maintenance planning is Frotas; the vehicles themselves are not.
      // Due days are the company's civil days, checked against its today.
      async () =>
        readsVehicles && fleetEnabled
          ? this.dashboardRepository.getMaintenanceStats(
              { today: businessDateKey(now, timeZone), timeZone },
              businessId,
            )
          : { pending: 0, recent: 0, overdue: 0 },
      async () =>
        readsVehicles
          ? this.dashboardRepository.countVehiclesByType(businessId)
          : { data: [] },
      // Service orders are Frotas: no costs without the module (DASH-MOD-1).
      async () =>
        readsCosts
          ? this.dashboardRepository.getCostsByMonth(
              { from: months.start, to: months.end, timeZone },
              businessId,
            )
          : [],
      async () =>
        readsOperation
          ? readOperationSummary(
              {
                operation: this.operationDayRepository,
                delivery: this.deliveryRepository,
              },
              businessId as string,
              operationDay(timeZone, now),
            )
          : null,
    ] as const);

    const byEntity = new Map<string, Map<string, number>>(
      Object.entries(monthly).map(([key, buckets]) => [
        key,
        new Map(buckets.map((bucket) => [bucket.month, bucket.count])),
      ]),
    );

    const countFor = (key: string, month: string): number =>
      byEntity.get(key)?.get(month) ?? 0;

    const spanFor = (key: string): number =>
      (
        (lastSpanCounts as Record<string, Array<{ count: number }>>)[key] ?? []
      ).reduce((sum, bucket) => sum + bucket.count, 0);

    const counts = Object.fromEntries(
      DASHBOARD_ENTITIES.map((entity) => {
        const basis = basisOf(entity.key);

        // A hidden entity answers zero (it was never queried): the cards are
        // gated by the web's route registry, and the zero keeps the
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
      const point: Record<string, string | number> = {
        month: monthLabel(month),
      };

      for (const entity of visible) {
        point[SERIES_KEY[entity.key]] = countFor(entity.key, month);
      }

      return point;
    }) as DashboardOverviewResponse["activityTrends"];

    const maintenanceCosts: DashboardOverviewResponse["maintenanceCosts"] = [];

    if (readsCosts) {
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

    return {
      counts,
      vehicleStatus,
      activityTrends,
      maintenanceStats,
      deliveryOperation: operationSummary?.totals ?? null,
      vehiclesByType: vehiclesByType.data || [],
      maintenanceCosts,
    };
  }
}

export {
  GetDashboardOverviewUseCase,
  MASTER_OVERVIEW_TTL_MS,
  OVERVIEW_READ_LANES,
  type OverviewNumbers,
};
