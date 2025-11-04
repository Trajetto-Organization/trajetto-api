import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";
import { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";

import { IRouteRepository } from "../../repositories/IRoute-repository";
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

    try {
      const createdRoute = await this.route.createRoute(data);

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
