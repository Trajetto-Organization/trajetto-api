import { inject, injectable } from "tsyringe";

import { IFuelRepository } from "../../repositories/IFuel-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";
import { Fuel } from "../../dtos/fuel-dto";

@injectable()
class GetPreviousFuelUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("FuelRepository")
    private fuel: IFuelRepository,
    @inject("VehicleRepository")
    private vehicle: IVehicleRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
  ) {}

  async execute(
    userId: string,
    vehicleId: string,
    currentFuelDate: string,
    businessId: string,
  ): Promise<Fuel | null> {
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

    // Get the previous fuel record for this vehicle before the specified date
    const previousFuel = await this.fuel.getPreviousFuelByVehicleId(
      vehicleId,
      new Date(currentFuelDate),
    );

    return previousFuel;
  }
}

export { GetPreviousFuelUseCase };
