import {
  RouteResult,
  OptimizedRouteResult,
} from "@/modules/routing/dtos/route-dto";

interface CalculateRouteParams {
  coordinates: Array<{ lat: number; lng: number }>;
  alternatives?: boolean;
  steps?: boolean;
}

interface OptimizeRouteParams {
  coordinates: Array<{ lat: number; lng: number }>;
  roundtrip?: boolean;
  source?: "first" | "any";
  destination?: "last" | "any";
}

interface CalculateMatrixParams {
  coordinates: Array<{ lat: number; lng: number }>;
}

interface IRoutingProvider {
  calculateRoute(params: CalculateRouteParams): Promise<RouteResult>;
  optimizeRoute(params: OptimizeRouteParams): Promise<OptimizedRouteResult>;
  calculateMatrix(params: CalculateMatrixParams): Promise<number[][]>;
}

export { IRoutingProvider };
