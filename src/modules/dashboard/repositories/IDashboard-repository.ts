import {
  DashboardEntity,
  PeriodGranularity,
  PeriodCountBucket,
  PeriodCostBucket,
  CountByMonthParams,
  MonthlyCountBucket,
  MonthlyCostBucket,
  VehicleStatusCountResult,
  MaintenanceStatsParams,
  MaintenanceStatsResult,
  VehicleTypeCountResult,
  EntityTotal,
} from "../dtos/dashboard-dto";

/**
 * Every window here is [from, to) in UTC instants and every bucket is a civil
 * day or month in `timeZone` — the company's zone, never the server's.
 */
interface IDashboardRepository {
  /**
   * The same count, for every month of a window, in ONE query.
   *
   * The overview draws eight months of nine entities. Asked one month at a
   * time that is 72 round trips; grouped in the database it is one.
   */
  countByMonth: (
    params: CountByMonthParams,
    businessId?: string,
  ) => Promise<MonthlyCountBucket[]>;

  /**
   * Every entity of the overview, every month, in ONE round trip.
   *
   * Nine `countByMonth` calls in parallel is nine connections held at once for
   * a single page view — which starved the pool and made the p95 of the WHOLE
   * API fifteen times worse while the median improved. Fewer queries is not
   * the goal; fewer queries AND less concurrency is.
   */
  countManyByMonth: (
    params: {
      entities: DashboardEntity[];
      from: Date;
      to: Date;
      timeZone: string;
    },
    businessId?: string,
  ) => Promise<Record<string, MonthlyCountBucket[]>>;

  /**
   * Every entity of a trend, every bucket, in ONE round trip — at whatever
   * granularity the window calls for.
   */
  countManyByPeriod: (
    params: {
      entities: DashboardEntity[];
      from: Date;
      to: Date;
      granularity: PeriodGranularity;
      timeZone: string;
    },
    businessId?: string,
  ) => Promise<Record<string, PeriodCountBucket[]>>;

  /**
   * Every catalogue of the overview as a stock, in ONE round trip: how many
   * rows exist now and how many were created before `before` (the company's
   * month start). The cards showed only what was created this month.
   */
  countManyTotals: (
    params: { entities: DashboardEntity[]; before: Date },
    businessId?: string,
  ) => Promise<Record<string, EntityTotal>>;

  /** The same spend, cut by day or by month, summed in the database. */
  getCostsByPeriod: (
    params: {
      from: Date;
      to: Date;
      granularity: PeriodGranularity;
      timeZone: string;
    },
    businessId?: string,
  ) => Promise<PeriodCostBucket[]>;

  countVehiclesByStatus: (
    businessId?: string,
  ) => Promise<VehicleStatusCountResult>;

  /**
   * The maintenance card, against the company's today and zone. The caller
   * reads the clock; the repository never does.
   */
  getMaintenanceStats: (
    params: MaintenanceStatsParams,
    businessId?: string,
  ) => Promise<MaintenanceStatsResult>;

  /**
   * The same spend, for every month of a window, summed in the database.
   *
   * One query instead of six, and two numbers back instead of every service
   * order row of half a year.
   */
  getCostsByMonth: (
    params: { from: Date; to: Date; timeZone: string },
    businessId?: string,
  ) => Promise<MonthlyCostBucket[]>;
  countVehiclesByType: (businessId?: string) => Promise<VehicleTypeCountResult>;
}

export { IDashboardRepository };
