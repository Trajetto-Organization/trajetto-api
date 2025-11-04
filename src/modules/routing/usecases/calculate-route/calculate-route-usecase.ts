import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";
import { IRoutingProvider } from "@/shared/providers/routing-provider/IRouting-provider";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";
import { RoutingCalculationError } from "../errors/routing-calculation-error";

import { AppError } from "@/shared/errors/AppError";
import { CalculateRouteProps, RouteResult } from "../../dtos/route-dto";

@injectable()
class CalculateRouteUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("VehicleRepository")
    private vehicle: IVehicleRepository,
    @inject("RoutingProvider")
    private routingProvider: IRoutingProvider,
  ) {}

  async execute(
    data: CalculateRouteProps,
    userId: string,
  ): Promise<RouteResult> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findBusiness = await this.business.findBusinessById(data.businessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    if (findUser.role !== "MASTER") {
      if (findUser.businessId !== data.businessId) {
        throw new AppError("Sem permissão para acessar esta empresa!", 403);
      }
    }

    // Validate vehicleId (optional, to use km_per_liter in the calculation)
    if (data.vehicleId) {
      const findVehicle = await this.vehicle.findVehicleById(data.vehicleId);

      if (!findVehicle) {
        throw new VehicleNotFoundError();
      }

      if (findVehicle.businessId !== data.businessId) {
        throw new AppError("Veículo não pertence a esta empresa!", 403);
      }
    }

    // Assembling coordinates for OSRM
    const coordinates = [data.origin, data.destination];

    if (data.waypoints && data.waypoints.length > 0) {
      // Insert waypoints between origin and destination.
      coordinates.splice(1, 0, ...data.waypoints);
    }

    try {
      // Calculate route via OSRM Provider
      const routeResult = await this.routingProvider.calculateRoute({
        coordinates,
        alternatives: data.alternatives,
        steps: data.steps,
      });

      return routeResult;
    } catch (error) {
      console.error("[CalculateRouteUseCase] Error:", error);
      throw new RoutingCalculationError(
        error instanceof Error ? error.message : undefined,
      );
    }
  }
}

export { CalculateRouteUseCase };
