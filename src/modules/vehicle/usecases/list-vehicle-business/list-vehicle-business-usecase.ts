import { inject, injectable } from "tsyringe";

import { IVehicleRepository } from "../../repositories/IVehicle-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { ListVehicleProps } from "../../dtos/vehicle-dto";

@injectable()
class ListVehicleBusinessUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("VehicleRepository")
    private vehicle: IVehicleRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
  ) {}

  async execute(
    userId: string,
    page: number,
    pageSize: number,
    businessId: string,
    search?: string,
  ): Promise<ListVehicleProps> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findBusinessById = await this.business.findBusinessById(businessId);

    if (!findBusinessById) {
      throw new BusinessNotFoundError();
    }

    // Auto-filter by driverId if user is a driver (BUSINESS_USER with driverId)
    const driverId =
      findUser.role === "BUSINESS_USER" && findUser.driverId
        ? findUser.driverId
        : undefined;

    try {
      const vehicleList = await this.vehicle.listVehicleBusiness({
        page,
        pageSize,
        businessId,
        search,
        driverId, // Pass driverId to filter vehicles for drivers
      });

      return vehicleList;
    } catch (error) {
      throw new AppError(
        "Não foi possível recuperar a lista dos veículos por empresa!",
        500,
      );
    }
  }
}

export { ListVehicleBusinessUseCase };
