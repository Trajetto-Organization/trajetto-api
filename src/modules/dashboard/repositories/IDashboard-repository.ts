import {
  CountByDateRangeParams,
  CountByDateRangeResult,
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
  countVehiclesByStatus: (
    businessId?: string,
  ) => Promise<VehicleStatusCountResult>;
  getMaintenanceStats: (businessId?: string) => Promise<MaintenanceStatsResult>;
  getMonthlyCosts: (
    params: MonthlyCostsParams,
    businessId?: string,
  ) => Promise<MonthlyCostsResult>;
  countVehiclesByType: (businessId?: string) => Promise<VehicleTypeCountResult>;
}

export { IDashboardRepository };
