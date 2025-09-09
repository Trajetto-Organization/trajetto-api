import { IDashboardRepository } from "../IDashboard-repository";
import {
  CountByDateRangeParams,
  CountByDateRangeResult,
  VehicleStatusCountResult,
  MaintenanceStatsResult,
  MonthlyCostsParams,
  MonthlyCostsResult,
  VehicleTypeCountResult,
} from "../../dtos/dashboard-dto";

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

  async countVehiclesByStatus(
    businessId?: string,
  ): Promise<VehicleStatusCountResult> {
    return this.data.vehicleStatus;
  }

  async getMaintenanceStats(
    businessId?: string,
  ): Promise<MaintenanceStatsResult> {
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
