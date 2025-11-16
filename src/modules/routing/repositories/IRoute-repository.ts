import {
  Route,
  CreateRouteProps,
  UpdateRouteProps,
  ListRoutesProps,
  ListRoutesResult,
} from "../dtos/route-dto";

interface IRouteRepository {
  createRoute: (data: CreateRouteProps) => Promise<Route>;
  listRoutes: (props: ListRoutesProps) => Promise<ListRoutesResult>;
  findRouteById: (id: string) => Promise<Route | null>;
  findRouteByBusinessAndId: (
    routeId: string,
    businessId: string,
  ) => Promise<Route | null>;
  updateRoute: (props: UpdateRouteProps) => Promise<Route>;
  deleteRoute: (id: string) => Promise<Route>;
  findRoutesBySimulation: (simulationId: string) => Promise<Route[]>;
  findRoutesByVehicle: (vehicleId: string) => Promise<Route[]>;
  findRoutesByDriver: (driverId: string) => Promise<Route[]>;
  countRoutesByBusiness: (businessId: string) => Promise<number>;

  // Analytics methods
  findRoutesByDateRange: (
    businessId: string,
    startDate: Date,
    endDate: Date,
  ) => Promise<Route[]>;
  getTotalDistanceByDateRange: (
    businessId: string,
    startDate: Date,
    endDate: Date,
  ) => Promise<number>;
}

export { IRouteRepository };
