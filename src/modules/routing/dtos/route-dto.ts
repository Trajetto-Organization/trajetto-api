import { Decimal } from "@prisma/client/runtime/library";

interface Coordinate {
  lat: number;
  lng: number;
  address?: string;
}

interface Route {
  id: string;
  origin: Coordinate;
  destination: Coordinate;
  waypoints: Coordinate[];
  distance: number; // meters
  duration: number; // seconds
  geometry: { type: string; coordinates: number[][] };
  estimatedCost: Decimal;
  status: string;
  businessId: string;
  vehicleId: string | null;
  driverId: string | null;
  simulationId: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  // Optional relationships
  vehicle?: {
    id: string;
    description: string;
    license_plate: string;
    brand: string;
    model: string;
  };
  driver?: {
    id: string;
    name: string;
    cpf: string;
  };
}

interface CreateRouteProps {
  origin: Coordinate;
  destination: Coordinate;
  waypoints?: Coordinate[];
  distance: number;
  duration: number;
  geometry: { type: string; coordinates: number[][] };
  estimatedCost: number;
  status?: string;
  businessId: string;
  vehicleId?: string;
  driverId?: string;
  simulationId?: string;
  metadata?: Record<string, unknown>;
}

interface UpdateRouteProps {
  id: string;
  origin?: Coordinate;
  destination?: Coordinate;
  waypoints?: Coordinate[];
  distance?: number;
  duration?: number;
  geometry?: { type: string; coordinates: number[][] };
  estimatedCost?: number;
  status?: string;
  vehicleId?: string | null;
  driverId?: string | null;
  metadata?: Record<string, unknown>;
}

interface ListRoutesProps {
  page?: number;
  limit?: number;
  search?: string;
  status?: string;
  businessId: string;
}

interface ListRoutesResult {
  data: Route[];
  total: number;
}

interface CalculateRouteProps {
  businessId: string;
  origin: Coordinate;
  destination: Coordinate;
  waypoints?: Coordinate[];
  vehicleId?: string;
  alternatives?: boolean;
  steps?: boolean;
}

interface RouteResult {
  distance: number; // meters
  duration: number; // seconds
  distanceKm: number; // km (helper)
  durationFormatted: string; // "1h 30min" (helper)
  estimatedCost: number;
  geometry: { type: string; coordinates: number[][] };
  steps?: Array<{
    distance: number;
    duration: number;
    instruction: string;
  }>;
}

interface OptimizeRouteProps {
  businessId: string;
  coordinates: Coordinate[]; // points to optimize
  roundtrip?: boolean;
  source?: "first" | "any";
  destination?: "last" | "any";
}

interface OptimizedRouteResult extends RouteResult {
  waypointsOrder: number[]; // optimized waypoint order
}

export {
  Route,
  CreateRouteProps,
  UpdateRouteProps,
  ListRoutesProps,
  ListRoutesResult,
  CalculateRouteProps,
  RouteResult,
  OptimizeRouteProps,
  OptimizedRouteResult,
  Coordinate,
};
