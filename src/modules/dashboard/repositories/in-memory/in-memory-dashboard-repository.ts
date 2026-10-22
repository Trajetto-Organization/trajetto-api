import { IDashboardRepository } from "../IDashboard-repository";
import {
  DashboardEntity,
  VehicleStatusCountResult,
  MaintenanceStatsParams,
  MaintenanceStatsResult,
  VehicleTypeCountResult,
  CountByMonthParams,
  MonthlyCountBucket,
  MonthlyCostBucket,
  PeriodGranularity,
  PeriodCountBucket,
  PeriodCostBucket,
  EntityTotal,
} from "../../dtos/dashboard-dto";

import { businessDateKey, businessMonthKey } from "@/shared/time/business-day";

import {
  tallyMaintenance,
  type MaintenanceVehicle,
} from "../maintenance-standing";

/** A vehicle as the status and maintenance counts read it, with its tenant. */
interface DashboardVehicleRow extends MaintenanceVehicle {
  businessId: string;
  status: keyof VehicleStatusCountResult;
}

/** The company's civil day or month, the same key the SQL groups by. */
function periodKey(
  at: Date,
  granularity: PeriodGranularity,
  timeZone: string,
): string {
  return granularity === "month"
    ? businessMonthKey(at, timeZone)
    : businessDateKey(at, timeZone);
}

/** [from, to), like the real `created_at >= from AND created_at < to`. */
function within(at: Date, from: Date, to: Date): boolean {
  return at.getTime() >= from.getTime() && at.getTime() < to.getTime();
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
    vehicles: DashboardVehicleRow[];
    vehicleTypes: { name: string; count: number; businessId?: string }[];
    monthlyCosts: {
      internal: number;
      external: number;
      date: string;
      businessId?: string;
    }[];
  } = {
    entityCounts: {},
    vehicles: [],
    vehicleTypes: [],
    monthlyCosts: [],
  };

  /**
   * The same grouping the database does, over the same fixture rows.
   *
   * Written as a grouping and not as a loop of per-bucket counts: a fake that
   * answered by looping would pass even if the real query grouped by the
   * wrong column, which is the one thing worth checking here.
   */
  async countManyByPeriod(
    params: {
      entities: DashboardEntity[];
      from: Date;
      to: Date;
      granularity: PeriodGranularity;
      timeZone: string;
    },
    businessId?: string,
  ): Promise<Record<string, PeriodCountBucket[]>> {
    const result: Record<string, PeriodCountBucket[]> = {};

    for (const entity of params.entities) {
      const entries = this.data.entityCounts[entity] ?? [];
      const buckets = new Map<string, number>();

      for (const entry of entries) {
        const at = new Date(entry.date);

        if (!within(at, params.from, params.to)) continue;

        // `business` is the tenant itself and carries no businessId, exactly
        // as in the real repository.
        if (
          businessId &&
          entity !== "business" &&
          entry.businessId !== businessId
        ) {
          continue;
        }

        const key = periodKey(at, params.granularity, params.timeZone);

        buckets.set(key, (buckets.get(key) ?? 0) + entry.count);
      }

      result[entity] = [...buckets.entries()].map(([period, count]) => ({
        period,
        count,
      }));
    }

    return result;
  }

  async countManyTotals(
    params: { entities: DashboardEntity[]; before: Date },
    businessId?: string,
  ): Promise<Record<string, EntityTotal>> {
    const result: Record<string, EntityTotal> = {};

    for (const entity of params.entities) {
      let total = 0;
      let before = 0;

      for (const entry of this.data.entityCounts[entity] ?? []) {
        if (
          businessId &&
          entity !== "business" &&
          entry.businessId !== businessId
        ) {
          continue;
        }

        total += entry.count;

        if (new Date(entry.date).getTime() < params.before.getTime())
          before += entry.count;
      }

      result[entity] = { total, before };
    }

    return result;
  }

  async countByMonth(
    params: CountByMonthParams,
    businessId?: string,
  ): Promise<MonthlyCountBucket[]> {
    const grouped = await this.countManyByPeriod(
      { ...params, entities: [params.entity], granularity: "month" },
      businessId,
    );

    return grouped[params.entity].map(({ period, count }) => ({
      month: period,
      count,
    }));
  }

  async countManyByMonth(
    params: {
      entities: DashboardEntity[];
      from: Date;
      to: Date;
      timeZone: string;
    },
    businessId?: string,
  ): Promise<Record<string, MonthlyCountBucket[]>> {
    const grouped = await this.countManyByPeriod(
      { ...params, granularity: "month" },
      businessId,
    );

    return Object.fromEntries(
      Object.entries(grouped).map(([entity, buckets]) => [
        entity,
        buckets.map(({ period, count }) => ({ month: period, count })),
      ]),
    );
  }

  async getCostsByPeriod(
    params: {
      from: Date;
      to: Date;
      granularity: PeriodGranularity;
      timeZone: string;
    },
    businessId?: string,
  ): Promise<PeriodCostBucket[]> {
    const buckets = new Map<string, PeriodCostBucket>();

    for (const entry of this.data.monthlyCosts) {
      const at = new Date(entry.date);

      if (!within(at, params.from, params.to)) continue;
      if (businessId && entry.businessId !== businessId) continue;

      const period = periodKey(at, params.granularity, params.timeZone);

      const bucket = buckets.get(period) ?? {
        period,
        internal: 0,
        external: 0,
      };

      bucket.internal += entry.internal;
      bucket.external += entry.external;

      buckets.set(period, bucket);
    }

    return [...buckets.values()];
  }

  async getCostsByMonth(
    params: { from: Date; to: Date; timeZone: string },
    businessId?: string,
  ): Promise<MonthlyCostBucket[]> {
    const buckets = await this.getCostsByPeriod(
      { ...params, granularity: "month" },
      businessId,
    );

    return buckets.map(({ period, internal, external }) => ({
      month: period,
      internal,
      external,
    }));
  }

  /** The same tenant filter as the real `where: { businessId }`. */
  private vehiclesOf(businessId?: string): DashboardVehicleRow[] {
    return businessId
      ? this.data.vehicles.filter(
          (vehicle) => vehicle.businessId === businessId,
        )
      : this.data.vehicles;
  }

  async countVehiclesByStatus(
    businessId?: string,
  ): Promise<VehicleStatusCountResult> {
    const counts = { ACTIVE: 0, INACTIVE: 0, BLOCKED: 0, IN_ROUTE: 0 };

    for (const vehicle of this.vehiclesOf(businessId)) {
      counts[vehicle.status] += 1;
    }

    return counts;
  }

  async getMaintenanceStats(
    params: MaintenanceStatsParams,
    businessId?: string,
  ): Promise<MaintenanceStatsResult> {
    return tallyMaintenance(
      this.vehiclesOf(businessId),
      params.today,
      params.timeZone,
    );
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

  addVehicle(vehicle: DashboardVehicleRow): void {
    this.data.vehicles.push({ ...vehicle });
  }

  addVehicleType(name: string, count: number, businessId?: string): void {
    this.data.vehicleTypes.push({ name, count, businessId });
  }

  addMonthlyCost(
    internal: number,
    external: number,
    date: string,
    businessId?: string,
  ): void {
    this.data.monthlyCosts.push({
      internal,
      external,
      date,
      businessId,
    });
  }
}

export { InMemoryDashboardRepository };
