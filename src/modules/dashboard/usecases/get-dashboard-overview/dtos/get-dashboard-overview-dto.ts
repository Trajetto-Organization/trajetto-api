interface DashboardOverviewRequest {
  userId: string;
}

interface EntityCount {
  currentMonth: number;
  lastMonth: number;
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
  activityTrends: Array<{
    month: string;
    vehicles: number;
    drivers: number;
    businesses: number;
    branches: number;
    parts: number;
    suppliers: number;
    serviceOrders: number;
    users: number;
    fines: number;
    deliveries: number;
    routes: number;
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
    preventive: number;
    corrective: number;
  }>;
}

export { DashboardOverviewRequest, DashboardOverviewResponse };
