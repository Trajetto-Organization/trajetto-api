/** Everything the dashboard counts by creation month. */
type DashboardEntity =
  | "vehicle"
  | "driver"
  | "business"
  | "branch"
  | "part"
  | "supplier"
  | "service-order"
  | "user"
  | "fine"

  // The deliveries module. Gated twice on the way in — by the company
  // having hired it and by the caller holding `delivery_manage` — because
  // the overview is the one screen every login opens.
  | "delivery"
  | "route";

/**
 * How many of one entity were created in each month of a window.
 *
 * Exists because the overview used to ask that question ONE MONTH AT A TIME:
 * nine entities across eight months is 72 round trips to answer a screen that
 * shows 72 numbers, and it made the dashboard the heaviest read in the
 * product by an order of magnitude. Grouped in the database, it is nine.
 */
interface CountByMonthParams {
  entity: DashboardEntity;

  /** [from, to): UTC instants, normally a business window's bounds. */
  from: Date;
  to: Date;

  /**
   * The company's zone (`Business.timezone`): the months are its civil
   * months. Never the server's — the container runs in UTC.
   */
  timeZone: string;
}

/** A catalogue as a stock: rows now, and rows created before a cut. */
interface EntityTotal {
  total: number;
  before: number;
}

interface MonthlyCountBucket {
  /** The company's civil month, as `YYYY-MM`. */
  month: string;
  count: number;
}

/**
 * How finely a trend is cut.
 *
 * The overview always wants months. The trends endpoint wants days for a
 * seven- or thirty-day window and months beyond that, and it used to get them
 * by asking one count per bucket per entity — 30 days × 9 entities plus 30
 * cost queries is three hundred round trips to draw one chart.
 */
type PeriodGranularity = "day" | "month";

interface PeriodCountBucket {
  /** `YYYY-MM-DD` for a day, `YYYY-MM` for a month, in the company's zone. */
  period: string;
  count: number;
}

interface PeriodCostBucket {
  period: string;
  internal: number;
  external: number;
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
  internal: number;
  external: number;
}

interface VehicleStatusCountResult {
  ACTIVE: number;
  INACTIVE: number;
  BLOCKED: number;
  IN_ROUTE: number;
}

/** What the maintenance card is counted against: the company's calendar. */
interface MaintenanceStatsParams {
  /** The company's today, "YYYY-MM-DD" (businessDateKey in Business.timezone). */
  today: string;

  /** The company's zone, in which each last maintenance falls on a day. */
  timeZone: string;
}

interface MaintenanceStatsResult {
  pending: number;
  recent: number;
  overdue: number;

  /**
   * Vehicles with no last maintenance date. Already inside `pending` (the
   * rule puts them in "A vencer"); counted apart so the card can say how
   * many of its "A vencer" only lack the record.
   */
  unrecorded: number;
}

interface VehicleTypeCountItem {
  name: string;
  count: number;
}

interface VehicleTypeCountResult {
  data: VehicleTypeCountItem[];
}

export {
  DashboardEntity,
  PeriodGranularity,
  PeriodCountBucket,
  PeriodCostBucket,
  CountByMonthParams,
  MonthlyCountBucket,
  MonthlyCostBucket,
  EntityTotal,
  VehicleStatusCountResult,
  MaintenanceStatsParams,
  MaintenanceStatsResult,
  VehicleTypeCountItem,
  VehicleTypeCountResult,
};
