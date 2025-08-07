import { inject, injectable } from "tsyringe";

import { IVehicleRepository } from "../../repositories/IVehicle-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { Vehicle } from "../../dtos/vehicle-dto";
import { VehicleNotFoundError } from "../errors/vehicle-not-found-error";

@injectable()
class GetVehicleUseCase {
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
    vehicleId: string,
    businessId: string,
  ): Promise<Vehicle | null> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findBusinessById = await this.business.findBusinessById(businessId);

    if (!findBusinessById) {
      throw new BusinessNotFoundError();
    }

    const findVehicleById = await this.vehicle.findVehicleById(vehicleId);

    if (!findVehicleById) {
      throw new VehicleNotFoundError();
    }

    try {
      const getVehicle = await this.vehicle.getVehicleByIdAndBusiness({
        businessId,
        vehicleId,
      });

      return getVehicle;
    } catch (error) {
      throw new AppError("Não foi possível recuperar o veículo!", 500);
    }
  }
}

export { GetVehicleUseCase };
