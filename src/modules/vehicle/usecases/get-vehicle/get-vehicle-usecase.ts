import { inject, injectable } from "tsyringe";

import { IVehicleRepository } from "../../repositories/IVehicle-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { VehicleWithLastFuel } from "../../dtos/vehicle-dto";
import { VehicleNotFoundError } from "../errors/vehicle-not-found-error";

import { VehicleNotAssignedToDriverError } from "../errors/vehicle-not-assigned-to-driver-error";
import { IFuelRepository } from "@/modules/fuel/repositories/IFuel-repository";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

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
  ): Promise<VehicleWithLastFuel> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    assertTenantAccess(findUser, businessId);

    const findBusinessById = await this.business.findBusinessById(businessId);

    if (!findBusinessById) {
      throw new BusinessNotFoundError();
    }

    // Scoped by company in the query itself: a vehicle of another company
    // is simply not found, with nothing that tells it exists.
    const getVehicle = await this.vehicle.getVehicleByIdAndBusiness({
      businessId,
      vehicleId,
    });

    if (!getVehicle) {
      throw new VehicleNotFoundError();
    }

    // A driver reads only a vehicle they may operate: the one they are
    // responsible for, or the one their released or running route uses
    // (FLEET-ASSIGN-1). The substitute driver used to be refused here.
    if (findUser.role === "BUSINESS_USER" && findUser.driverId) {
      const allowed = await this.vehicle.canDriverOperateVehicle({
        vehicleId,
        driverId: findUser.driverId,
        businessId,
      });

      if (!allowed) {
        throw new VehicleNotAssignedToDriverError();
      }
    }

    try {
      const lastFuel = await this.fuel.getPreviousFuelByVehicleId(
        vehicleId,
        new Date(),
        businessId,
      );

      return {
        ...getVehicle,
        last_fuel_mileage: lastFuel?.current_mileage || null,
        last_fuel_date: lastFuel?.refueling_date || null,
      };
    } catch (error) {
      throw new AppError("Não foi possível recuperar o veículo!", 500);
    }
  }
}

export { GetVehicleUseCase };
