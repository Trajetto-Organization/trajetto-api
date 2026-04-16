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
  }>;
  maintenanceStats: {
    pending: number;
    recent: number;
    overdue: number;
  };
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
