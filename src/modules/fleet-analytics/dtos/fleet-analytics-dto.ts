// Fleet Analytics Entity
interface FleetAnalytics {
  id: string;
  analyticsType: string;
  period: string;
  startDate: Date;
  endDate: Date;
  results: AnalyticsResults;
  metadata?: Record<string, unknown> | null;
  businessId: string;
  created_at: Date;
  updated_at: Date;
}

// Analytics Results (flexible structure based on type)
type AnalyticsResults =
  | RouteEfficiencyResults
  | CostAnalysisResults
  | VehicleUtilizationResults
  | FuelConsumptionResults
  | MaintenanceCostResults;

// Route Efficiency Analytics
interface RouteEfficiencyResults {
  totalRoutes: number;
  totalDistance: number; // km
  totalDuration: number; // seconds
  avgSpeed: number; // km/h
  avgDistancePerRoute: number; // km
  avgDurationPerRoute: number; // seconds
  efficiencyScore: number; // 0-100
  topPerformingRoutes: Array<{
    routeId: string;
    routeName?: string;
    distance: number;
    duration: number;
    efficiency: number;
  }>;
  lowPerformingRoutes: Array<{
    routeId: string;
    routeName?: string;
    distance: number;
    duration: number;
    efficiency: number;
  }>;
}

// Cost Analysis Analytics
interface CostAnalysisResults {
  totalCost: number; // R$ (fuel + maintenance)
  fuelCost: number; // R$
  maintenanceCost: number; // R$
  costPerKm: number; // R$/km
  costPerRoute: number; // R$/route
  costBreakdown: {
    fuel: number; // R$
    maintenance: number; // R$
  };
  topExpensiveVehicles: Array<{
    vehicleId: string;
    vehiclePlate: string;
    totalCost: number;
  }>;
}

// Vehicle Utilization Analytics
interface VehicleUtilizationResults {
  totalVehicles: number;
  activeVehicles: number;
  inactiveVehicles: number;
  blockedVehicles: number;
  inRouteVehicles: number;
  utilizationRate: number; // %
  avgDistancePerVehicle: number; // km
  avgRoutesPerVehicle: number;
  topUtilizedVehicles: Array<{
    vehicleId: string;
    vehiclePlate: string;
    totalRoutes: number;
    totalDistance: number;
    utilizationRate: number;
  }>;
  underutilizedVehicles: Array<{
    vehicleId: string;
    vehiclePlate: string;
    totalRoutes: number;
    totalDistance: number;
    utilizationRate: number;
  }>;
}

// Fuel Consumption Analytics
interface FuelConsumptionResults {
  totalFuelCost: number; // R$
  totalLiters: number; // L
  avgCostPerLiter: number; // R$/L
  avgConsumption: number; // km/L
  totalDistance: number; // km
  costPerKm: number; // R$/km
  topConsumingVehicles: Array<{
    vehicleId: string;
    vehiclePlate: string;
    totalLiters: number;
    totalCost: number;
    avgConsumption: number;
  }>;
  fuelTypeBreakdown: Array<{
    fuelType: string;
    totalLiters: number;
    totalCost: number;
    percentage: number;
  }>;
}

// Maintenance Cost Analytics
interface MaintenanceCostResults {
  totalMaintenanceCost: number; // R$
  totalServiceOrders: number;
  avgCostPerService: number; // R$
  preventiveCost: number; // R$
  correctiveCost: number; // R$
  costPerKm: number; // R$/km
  topMaintenanceVehicles: Array<{
    vehicleId: string;
    vehiclePlate: string;
    totalCost: number;
    totalServices: number;
    avgCost: number;
  }>;
  maintenanceTypeBreakdown: {
    preventive: number; // %
    corrective: number; // %
  };
}

// Create Analytics Props
interface CreateFleetAnalyticsProps {
  analyticsType: string;
  period: string;
  startDate: Date;
  endDate: Date;
  results: AnalyticsResults;
  metadata?: Record<string, unknown>;
  businessId: string;
}

// Update Analytics Props
interface UpdateFleetAnalyticsProps {
  id: string;
  analyticsType?: string;
  period?: string;
  startDate?: Date;
  endDate?: Date;
  results?: AnalyticsResults;
  metadata?: Record<string, unknown>;
}

// List Analytics Props
interface ListFleetAnalyticsProps {
  page: number;
  pageSize: number;
  businessId: string;
  analyticsType?: string;
  period?: string;
  startDate?: Date;
  endDate?: Date;
}

// List Analytics Result
interface ListFleetAnalyticsResult {
  data: FleetAnalytics[];
  total: number;
}

// Generate Analytics Request
interface GenerateAnalyticsRequest {
  analyticsType: string; // route_efficiency, cost_analysis, vehicle_utilization, fuel_consumption, maintenance_cost
  period: string; // daily, weekly, monthly, custom
  startDate: Date;
  endDate: Date;
  businessId: string;
  metadata?: Record<string, unknown>;
}

// Generate Analytics Response
interface GenerateAnalyticsResponse {
  analytics: FleetAnalytics;
  status: "completed" | "processing";
  message?: string;
}

export {
  FleetAnalytics,
  AnalyticsResults,
  RouteEfficiencyResults,
  CostAnalysisResults,
  VehicleUtilizationResults,
  FuelConsumptionResults,
  MaintenanceCostResults,
  CreateFleetAnalyticsProps,
  UpdateFleetAnalyticsProps,
  ListFleetAnalyticsProps,
  ListFleetAnalyticsResult,
  GenerateAnalyticsRequest,
  GenerateAnalyticsResponse,
};
