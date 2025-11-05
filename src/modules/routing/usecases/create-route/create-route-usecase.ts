import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";
import { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";

import { IRouteRepository } from "../../repositories/IRoute-repository";
import { IRoutingProvider } from "@/shared/providers/routing-provider/IRouting-provider";

import { NotificationService } from "@/shared/services/notification-service";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";
import { DriverNotFoundError } from "@/modules/driver/usecases/errors/driver-not-found-error";

import { CreateRouteProps, Route } from "../../dtos/route-dto";
import { AppError } from "@/shared/errors/AppError";

@injectable()
class CreateRouteUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("VehicleRepository")
    private vehicle: IVehicleRepository,
    @inject("DriverRepository")
    private driver: IDriverRepository,
    @inject("RouteRepository")
    private route: IRouteRepository,
    @inject("RoutingProvider")
    private routingProvider: IRoutingProvider,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute(data: CreateRouteProps, userId: string): Promise<Route> {
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

    if (data.vehicleId) {
      const findVehicle = await this.vehicle.findVehicleById(data.vehicleId);

      if (!findVehicle) {
        throw new VehicleNotFoundError();
      }

      if (findVehicle.businessId !== data.businessId) {
        throw new AppError("Veículo não pertence a esta empresa!", 403);
      }
    }

    if (data.driverId) {
      const findDriver = await this.driver.findDriverById(data.driverId);

      if (!findDriver) {
        throw new DriverNotFoundError();
      }

      if (findDriver.businessId !== data.businessId) {
        throw new AppError("Motorista não pertence a esta empresa!", 403);
      }
    }

    // ⭐ SMART LOGIC: Automatically calculates if fields are missing.
    if (
      !data.distance ||
      !data.duration ||
      !data.geometry ||
      !data.estimatedCost
    ) {
      console.log(
        "[CreateRouteUseCase] Campos calculados não fornecidos. Calculando automaticamente...",
      );

      try {
        // Creates coordinate array: [origin, ...waypoints, destination]
        const coordinates = [
          data.origin,
          ...(data.waypoints || []),
          data.destination,
        ];

        // Calculates via OSRM
        const routeCalculation = await this.routingProvider.calculateRoute({
          coordinates,
          alternatives: false,
          steps: false,
        });

        // Fill in calculated fields.
        data.distance = routeCalculation.distance;
        data.duration = routeCalculation.duration;

        data.geometry = routeCalculation.geometry;

        // Calculates estimated cost (if not provided)
        if (!data.estimatedCost) {
          const costPerKm = data.costPerKm || 2.5;
          data.estimatedCost = routeCalculation.distanceKm * costPerKm;
        }

        console.log(
          `[CreateRouteUseCase] Cálculo automático concluído: ${routeCalculation.distanceKm}km, ${routeCalculation.durationFormatted}`,
        );
      } catch (error) {
        console.error("[CreateRouteUseCase] Erro ao calcular rota:", error);
        throw new AppError(
          "Erro ao calcular dados da rota. Verifique as coordenadas fornecidas.",
          400,
        );
      }
    }

    try {
      const createdRoute = await this.route.createRoute(
        data as Required<CreateRouteProps>,
      );

      this.notificationService.createActivityIfEnabled({
        type: "Rota",
        action: "create",
        entityId: createdRoute.id,
        description: `Rota criada | ${createdRoute.distance}m | ${createdRoute.duration}s`,
        status: createdRoute.status,
        performedBy: userId,
        businessId: data.businessId,
      });

      return createdRoute;
    } catch (error) {
      console.error("[CreateRouteUseCase] Error:", error);
      throw new AppError(
        "Houve um erro ao tentar criar a rota! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { CreateRouteUseCase };
