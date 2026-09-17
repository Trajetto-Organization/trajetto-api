import { IDashboardRepository } from "../IDashboard-repository";
import {
  CountByDateRangeParams,
  CountByDateRangeResult,
  VehicleStatusCountResult,
  MaintenanceStatsResult,
  MonthlyCostsParams,
  MonthlyCostsResult,
  VehicleTypeCountResult,
  CountByMonthParams,
  MonthlyCountBucket,
  MonthlyCostBucket,
  PeriodGranularity,
  PeriodCountBucket,
  PeriodCostBucket,
} from "../../dtos/dashboard-dto";

/** Local wall time, the same basis the real query truncates on. */
function periodKey(at: Date, granularity: PeriodGranularity): string {
  const year = at.getFullYear();
  const month = String(at.getMonth() + 1).padStart(2, "0");

  if (granularity === "month") return `${year}-${month}`;

  return `${year}-${month}-${String(at.getDate()).padStart(2, "0")}`;
}

class InMemoryDashboardRepository implements IDashboardRepository {
  public data: {
    entityCounts: {
      [entity: string]: {
        count: number;
        date: string;
        businessId?: string;
      }[];
    };
    vehicleStatus: VehicleStatusCountResult;
    maintenanceStats: MaintenanceStatsResult;
    vehicleTypes: { name: string; count: number; businessId?: string }[];
    monthlyCosts: {
      preventive: number;
      corrective: number;
      date: string;
      businessId?: string;
    }[];
  } = {
    entityCounts: {},
    vehicleStatus: { ACTIVE: 0, INACTIVE: 0, BLOCKED: 0, IN_ROUTE: 0 },
    maintenanceStats: { pending: 0, recent: 0, overdue: 0 },
    vehicleTypes: [],
    monthlyCosts: [],
  };

  /**
   * The same grouping the database does, over the same fixture rows.
   *
   * Written as a grouping and not as a loop of `countByDateRange` calls: a
   * fake that answered by looping would pass even if the real query grouped by
   * the wrong column, which is the one thing worth checking here.
   */
  async countByMonth(
    params: CountByMonthParams,
    businessId?: string,
  ): Promise<MonthlyCountBucket[]> {
    const entries = this.data.entityCounts[params.entity] ?? [];

    const buckets = new Map<string, number>();

    for (const entry of entries) {
      const at = new Date(entry.date);

      if (at < params.from || at > params.to) continue;

      // `business` is the tenant itself and carries no businessId, exactly as
      // in the real repository.
      if (
        businessId &&
        params.entity !== "business" &&
        entry.businessId !== businessId
      ) {
        continue;
      }

      const month = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}`;

      buckets.set(month, (buckets.get(month) ?? 0) + entry.count);
    }

    return [...buckets.entries()].map(([month, count]) => ({ month, count }));
  }

  async countManyByMonth(
    params: {
      entities: CountByMonthParams["entity"][];
      from: Date;
      to: Date;
    },
    businessId?: string,
  ): Promise<Record<string, MonthlyCountBucket[]>> {
    const result: Record<string, MonthlyCountBucket[]> = {};

    for (const entity of params.entities) {
      result[entity] = await this.countByMonth(
        { entity, from: params.from, to: params.to },
        businessId,
      );
    }

    return result;
  }

  /**
   * The same grouping the database does, at the same two granularities.
   *
   * Written as its own grouping rather than as a loop over `countByMonth`,
   * for the reason stated above: a fake that answered by looping would agree
   * with a real query that grouped by the wrong column.
   */
  async countManyByPeriod(
    params: {
      entities: CountByMonthParams["entity"][];
      from: Date;
      to: Date;
      granularity: PeriodGranularity;
    },
    businessId?: string,
  ): Promise<Record<string, PeriodCountBucket[]>> {
    const result: Record<string, PeriodCountBucket[]> = {};

    for (const entity of params.entities) {
      const entries = this.data.entityCounts[entity] ?? [];
      const buckets = new Map<string, number>();

      for (const entry of entries) {
        const at = new Date(entry.date);

        if (at < params.from || at > params.to) continue;

        if (
          businessId &&
          entity !== "business" &&
          entry.businessId !== businessId
        ) {
          continue;
        }

        buckets.set(
          periodKey(at, params.granularity),
          (buckets.get(periodKey(at, params.granularity)) ?? 0) + entry.count,
        );
      }

      result[entity] = [...buckets.entries()].map(([period, count]) => ({
        period,
        count,
      }));
    }

    return result;
  }

  async getCostsByPeriod(
    params: { from: Date; to: Date; granularity: PeriodGranularity },
    businessId?: string,
  ): Promise<PeriodCostBucket[]> {
    const buckets = new Map<string, PeriodCostBucket>();

    for (const entry of this.data.monthlyCosts) {
      const at = new Date(entry.date);

      if (at < params.from || at > params.to) continue;
      if (businessId && entry.businessId !== businessId) continue;

      const period = periodKey(at, params.granularity);

      const bucket = buckets.get(period) ?? {
        period,
        preventive: 0,
        corrective: 0,
      };

      bucket.preventive += entry.preventive;
      bucket.corrective += entry.corrective;

      buckets.set(period, bucket);
    }

    return [...buckets.values()];
  }

  async getCostsByMonth(
    params: { from: Date; to: Date },
    businessId?: string,
  ): Promise<MonthlyCostBucket[]> {
    const buckets = new Map<string, MonthlyCostBucket>();

    for (const entry of this.data.monthlyCosts) {
      const at = new Date(entry.date);

      if (at < params.from || at > params.to) continue;
      if (businessId && entry.businessId !== businessId) continue;

      const month = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}`;

      const bucket = buckets.get(month) ?? {
        month,
        preventive: 0,
        corrective: 0,
      };

      bucket.preventive += entry.preventive;
      bucket.corrective += entry.corrective;

      buckets.set(month, bucket);
    }

    return [...buckets.values()];
  }

  async countByDateRange(
    params: CountByDateRangeParams,
    businessId?: string,
  ): Promise<CountByDateRangeResult> {
    const { entity, startDate, endDate } = params;

    if (!this.data.entityCounts[entity]) {
      return { count: 0 };
    }

    const filteredCounts = this.data.entityCounts[entity].filter((item) => {
      const itemDate = new Date(item.date);
      const start = new Date(startDate);

      const end = new Date(endDate);

      const dateInRange = itemDate >= start && itemDate <= end;
      const businessMatches = !businessId || item.businessId === businessId;

      return dateInRange && businessMatches;
    });

    const totalCount = filteredCounts.reduce(
      (sum, item) => sum + item.count,
      0,
    );

    return { count: totalCount };
  }

  async countVehiclesByStatus(): Promise<VehicleStatusCountResult> {
    return this.data.vehicleStatus;
  }

  async getMaintenanceStats(): Promise<MaintenanceStatsResult> {
    return this.data.maintenanceStats;
  }

  async getMonthlyCosts(
    params: MonthlyCostsParams,
    businessId?: string,
  ): Promise<MonthlyCostsResult> {
    const { startDate, endDate } = params;

    const filteredCosts = this.data.monthlyCosts.filter((cost) => {
      const costDate = new Date(cost.date);
      const start = new Date(startDate);

      const end = new Date(endDate);

      const dateInRange = costDate >= start && costDate <= end;
      const businessMatches = !businessId || cost.businessId === businessId;

      return dateInRange && businessMatches;
    });

    const totals = filteredCosts.reduce(
      (sum, cost) => ({
        preventive: sum.preventive + cost.preventive,
        corrective: sum.corrective + cost.corrective,
      }),
      { preventive: 0, corrective: 0 },
    );

    return totals;
  }

  async countVehiclesByType(
    businessId?: string,
  ): Promise<VehicleTypeCountResult> {
    let filteredTypes = this.data.vehicleTypes;

    if (businessId) {
      filteredTypes = this.data.vehicleTypes.filter(
        (type) => type.businessId === businessId,
      );
    }

    return { data: filteredTypes };
  }

  // Helper methods for tests
  addEntityCount(
    entity: string,
    count: number,
    date: string,
    businessId?: string,
  ): void {
    if (!this.data.entityCounts[entity]) {
      this.data.entityCounts[entity] = [];
    }

    this.data.entityCounts[entity].push({
      count,
      date,
      businessId,
    });
  }

  setVehicleStatus(status: VehicleStatusCountResult): void {
    this.data.vehicleStatus = status;
  }

  setMaintenanceStats(stats: MaintenanceStatsResult): void {
    this.data.maintenanceStats = stats;
  }

  addVehicleType(name: string, count: number, businessId?: string): void {
    this.data.vehicleTypes.push({ name, count, businessId });
  }

  addMonthlyCost(
    preventive: number,
    corrective: number,
    date: string,
    businessId?: string,
  ): void {
    this.data.monthlyCosts.push({
      preventive,
      corrective,
      date,
      businessId,
    });
  }
}

export { InMemoryDashboardRepository };
