import { Coordinate } from "@/modules/routing/dtos/route-dto";

interface Simulation {
  id: string;
  name: string;
  description?: string | null;
  status: string; // pending, processing, completed, failed, cancelled
  results?: SimulationResults | null;
  metadata?: Record<string, unknown>;
  businessId: string;
  created_at: Date;
  updated_at: Date;
  // Optional relationships
  routes?: Array<{
    id: string;
    name?: string | null;
    origin: Coordinate;
    destination: Coordinate;
    waypoints: Coordinate[];
    distance: number;
    duration: number;
    estimatedCost: number;
  }>;
}

interface SimulationResults {
  routes: Array<{
    name?: string;
    origin: Coordinate;
    destination: Coordinate;
    waypoints: Coordinate[];
    distance: number;
    duration: number;
    distanceKm: number;
    durationFormatted: string;
    estimatedCost: number;
    geometry: { type: string; coordinates: number[][] };
    vehicleId?: string;
    driverId?: string;
  }>;
  totalDistance: number;
  totalDuration: number;
  totalCost: number;
  completedAt?: string;
}

interface RouteForSimulation {
  name?: string;
  origin: Coordinate;
  destination: Coordinate;
  waypoints?: Coordinate[];
  vehicleId?: string;
  driverId?: string;
}

interface CreateSimulationProps {
  name: string;
  description?: string | null;
  businessId: string;
  routes: RouteForSimulation[];
  metadata?: Record<string, unknown>;
}

interface UpdateSimulationProps {
  id: string;
  name?: string;
  description?: string | null;
  status?: string;
  results?: SimulationResults;
  metadata?: Record<string, unknown>;
}

interface ListSimulationsProps {
  page: number;
  pageSize: number;
  search?: string;
  status?: string;
  businessId: string;
  currentUserRole: string;
}

interface ListSimulationsResult {
  data: any[];
  total: number;
}

interface RunSimulationRequest {
  name: string;
  description?: string | null;
  businessId: string;
  routes: RouteForSimulation[];
  metadata?: Record<string, unknown>;
}

interface RunSimulationResponse {
  simulation: Simulation;
  status: "completed" | "processing";
  message?: string;
}

export {
  Simulation,
  SimulationResults,
  RouteForSimulation,
  CreateSimulationProps,
  UpdateSimulationProps,
  ListSimulationsProps,
  ListSimulationsResult,
  RunSimulationRequest,
  RunSimulationResponse,
};
