import { inject, injectable } from "tsyringe";

import { IVehicleRepository } from "../../repositories/IVehicle-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { VehicleWithLastFuel } from "../../dtos/vehicle-dto";
import { VehicleNotFoundError } from "../errors/vehicle-not-found-error";

import { VehicleNotAssignedToDriverError } from "../errors/vehicle-not-assigned-to-driver-error";
import { IFuelRepository } from "@/modules/fuel/repositories/IFuel-repository";

@injectable()
class GetVehicleUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("VehicleRepository")
    private vehicle: IVehicleRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("FuelRepository")
    private fuel: IFuelRepository,
  ) {}

  async execute(
    userId: string,
    vehicleId: string,
    businessId: string,
  ): Promise<VehicleWithLastFuel | null> {
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

    // Security: If user is a driver, verify vehicle belongs to them
    if (findUser.role === "BUSINESS_USER" && findUser.driverId) {
      if (findVehicleById.driverId !== findUser.driverId) {
        throw new VehicleNotAssignedToDriverError();
      }
    }

    try {
      const getVehicle = await this.vehicle.getVehicleByIdAndBusiness({
        businessId,
        vehicleId,
      });

      if (!getVehicle) {
        return null;
      }

      // Get the last fuel record for this vehicle
      const lastFuel = await this.fuel.getPreviousFuelByVehicleId(
        vehicleId,
        new Date(),
      );

      // Return vehicle with last fuel data
      const vehicleWithLastFuel: VehicleWithLastFuel = {
        ...getVehicle,
        last_fuel_mileage: lastFuel?.current_mileage || null,
        last_fuel_date: lastFuel?.refueling_date || null,
      };

      return vehicleWithLastFuel;
    } catch (error) {
      throw new AppError("Não foi possível recuperar o veículo!", 500);
    }
  }
}

export { GetVehicleUseCase };
