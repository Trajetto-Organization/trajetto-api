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

/**
 * How many of one entity were created in each month of a window.
 *
 * Exists because the overview used to ask that question ONE MONTH AT A TIME:
 * nine entities across eight months is 72 round trips to answer a screen that
 * shows 72 numbers, and it made the dashboard the heaviest read in the
 * product by an order of magnitude. Grouped in the database, it is nine.
 */
interface CountByMonthParams {
  entity: CountByDateRangeParams["entity"];

  /** Inclusive, as a local-timezone Date. */
  from: Date;
  to: Date;
}

interface MonthlyCountBucket {
  /** First day of the month, local, as `YYYY-MM`. */
  month: string;
  count: number;
}

/**
 * Maintenance spend per month, summed in the database.
 *
 * The old shape asked one month at a time AND pulled every service order row
 * of that month back to add them up in JavaScript. At a carrier with a real
 * workshop that is thousands of rows over the wire to produce two numbers.
 */
interface MonthlyCostBucket {
  month: string;
  preventive: number;
  corrective: number;
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
  CountByMonthParams,
  MonthlyCountBucket,
  MonthlyCostBucket,
  VehicleStatusCountResult,
  MaintenanceStatsResult,
  MonthlyCostsParams,
  MonthlyCostsResult,
  VehicleTypeCountItem,
  VehicleTypeCountResult,
  ModelWithCount,
};
