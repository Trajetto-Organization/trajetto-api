import type { CountBasis } from "../../shared/count-comparison";

interface DashboardOverviewRequest {
  userId: string;
}

interface EntityCount {
  /** Created in the company's current civil month (the trend's last point). */
  currentMonth: number;
  /** Created in the previous civil month. */
  lastMonth: number;
  /** "total" for a catalogue, "month_to_date" for an operation (count-comparison). */
  basis: CountBasis;
  /** What the card shows: the current total, or this month so far. */
  value: number;
  /** The same measure one period back: the total at the month's start, or last month up to the same point. */
  previous: number;
}

interface DashboardOverviewResponse {
  counts: {
    vehicles: EntityCount;
    drivers: EntityCount;
    businesses: EntityCount;
    branches: EntityCount;
    parts: EntityCount;
    suppliers: EntityCount;
    serviceOrders: EntityCount;
    users: EntityCount;
    fines: EntityCount;
    deliveries: EntityCount;
    routes: EntityCount;
  };
  vehicleStatus: {
    ACTIVE: number;
    INACTIVE: number;
    BLOCKED: number;
    IN_ROUTE: number;
  };
  /**
   * One point per month of the company's calendar. A series is present only
   * when this viewer may see it and the company hired its module; absent
   * means "no line", not zero (DLVP-ADM-1).
   */
  activityTrends: Array<{
    month: string;
    vehicles?: number;
    drivers?: number;
    businesses?: number;
    branches?: number;
    parts?: number;
    suppliers?: number;
    serviceOrders?: number;
    users?: number;
    fines?: number;
    deliveries?: number;
    routes?: number;
  }>;
  maintenanceStats: {
    pending: number;
    recent: number;
    overdue: number;
  };

  /**
   * What the operation is doing right now, as opposed to how much of it was
   * created this month.
   *
   * The counts above answer "how big is this"; a dispatcher opening the
   * overview at seven in the morning is asking "what is not on a route yet"
   * and "what failed yesterday". Same numbers the monitoring panel draws,
   * from the same query, so the two screens cannot disagree.
   *
   * Null rather than zeroes when there is nothing to say: a MASTER has no
   * single company to summarise, a company that did not hire the module has
   * no operation, and a profile without `delivery_manage` must not be shown
   * one. Zeroes would read as "a quiet day".
   */
  deliveryOperation: {
    unassigned: number;
    designated: number;
    inRoute: number;
    deliveredToday: number;
    failedToday: number;
    occurrencesToday: number;
  } | null;
  recentActivity: Array<{
    id: string;
    type: string;
    action: string;
    entityId: string;
    description: string;
    status: string;
    performedBy: string | null;
    businessId: string | null;
    visibilityLevel?: string | null;
    performingUserRole?: string | null;
    userEmail?: string;
    userName?: string;
    userRole?: string;
    business_name?: string;
    created_at: string | Date;
    updated_at: string | Date;
  }>;
  vehiclesByType: Array<{
    name: string;
    count: number;
  }>;
  maintenanceCosts: Array<{
    month: string;
    internal: number;
    external: number;
  }>;
}

export { DashboardOverviewRequest, DashboardOverviewResponse };
