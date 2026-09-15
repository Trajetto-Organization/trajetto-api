import {
  CountByDateRangeParams,
  CountByDateRangeResult,
  CountByMonthParams,
  MonthlyCountBucket,
  MonthlyCostBucket,
  VehicleStatusCountResult,
  MaintenanceStatsResult,
  MonthlyCostsParams,
  MonthlyCostsResult,
  VehicleTypeCountResult,
} from "../dtos/dashboard-dto";

interface IDashboardRepository {
  countByDateRange: (
    params: CountByDateRangeParams,
    businessId?: string,
  ) => Promise<CountByDateRangeResult>;

  /**
   * The same count, for every month of a window, in ONE query.
   *
   * The overview draws eight months of nine entities. Asked one month at a
   * time that is 72 round trips; grouped in the database it is one, and the
   * numbers are identical because the grouping is the same `created_at`
   * window the single count uses.
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
      entities: CountByMonthParams["entity"][];
      from: Date;
      to: Date;
    },
    businessId?: string,
  ) => Promise<Record<string, MonthlyCountBucket[]>>;
  countVehiclesByStatus: (
    businessId?: string,
  ) => Promise<VehicleStatusCountResult>;
  getMaintenanceStats: (businessId?: string) => Promise<MaintenanceStatsResult>;
  getMonthlyCosts: (
    params: MonthlyCostsParams,
    businessId?: string,
  ) => Promise<MonthlyCostsResult>;

  /**
   * The same spend, for every month of a window, summed in the database.
   *
   * One query instead of six, and two numbers back instead of every service
   * order row of half a year.
   */
  getCostsByMonth: (
    params: { from: Date; to: Date },
    businessId?: string,
  ) => Promise<MonthlyCostBucket[]>;
  countVehiclesByType: (businessId?: string) => Promise<VehicleTypeCountResult>;
}

export { IDashboardRepository };
