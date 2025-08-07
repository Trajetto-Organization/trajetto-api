interface CountByDateRangeParams {
  startDate: string;
  endDate: string;
  entity:
    | "vehicle"
    | "driver"
    | "business"
    | "branch"
    | "part"
    | "supplier"
    | "service-order"
    | "user"
    | "fine";
}

interface CountByDateRangeResult {
  count: number;
}

interface VehicleStatusCountResult {
  ACTIVE: number;
  INACTIVE: number;
  BLOCKED: number;
  IN_ROUTE: number;
}

interface MaintenanceStatsResult {
  pending: number;
  recent: number;
  overdue: number;
}

interface MonthlyCostsParams {
  startDate: string;
  endDate: string;
}

interface MonthlyCostsResult {
  preventive: number;
  corrective: number;
}

interface VehicleTypeCountItem {
  name: string;
  count: number;
}

interface VehicleTypeCountResult {
  data: VehicleTypeCountItem[];
}

interface ModelWithCount {
  count: (args: { where: any }) => Promise<number>;
}

export {
  CountByDateRangeParams,
  CountByDateRangeResult,
  VehicleStatusCountResult,
  MaintenanceStatsResult,
  MonthlyCostsParams,
  MonthlyCostsResult,
  VehicleTypeCountItem,
  VehicleTypeCountResult,
  ModelWithCount,
};
