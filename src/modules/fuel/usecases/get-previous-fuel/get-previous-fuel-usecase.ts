import { inject, injectable } from "tsyringe";

import { IFuelRepository } from "../../repositories/IFuel-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";
import { VehicleNotAssignedToDriverError } from "@/modules/vehicle/usecases/errors/vehicle-not-assigned-to-driver-error";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";
import { PreviousFuelReading } from "../../dtos/fuel-dto";

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
  ): Promise<PreviousFuelReading | null> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    // The company comes from the query; only the MASTER may name another
    // one. Compared with the user's own company, a MASTER (who has none)
    // was always refused, and the details dialog of /admin never showed the
    // consumption since the previous fueling.
    assertTenantAccess(findUser, businessId);

    const findBusinessById = await this.business.findBusinessById(businessId);

    if (!findBusinessById) {
      throw new BusinessNotFoundError();
    }

    const findVehicleById = await this.vehicle.findVehicleById(vehicleId);

    // The same answer for "does not exist" and "not this company's": the id
    // of another company's vehicle would otherwise return its previous
    // fueling — litres, value, odometer, station, photo — and feeding the
    // returned date back in walked its whole history.
    if (!findVehicleById || findVehicleById.businessId !== businessId) {
      throw new VehicleNotFoundError();
    }

    // A driver reads only what is theirs (decision 4.4): the previous
    // fueling of a vehicle they may operate — the same rule that lets them
    // fuel it (shared/vehicle/driver-vehicle-access) — never the fleet's.
    if (findUser.driverId) {
      const allowed = await this.vehicle.canDriverOperateVehicle({
        vehicleId,
        driverId: findUser.driverId,
        businessId,
      });

      // The code the vehicle, service-order and fuel-history routes give
      // the same case (a vehicle of their company that is not theirs).
      if (!allowed) {
        throw new VehicleNotAssignedToDriverError();
      }
    }

    const previousFuel = await this.fuel.getPreviousFuelByVehicleId(
      vehicleId,
      new Date(currentFuelDate),
      businessId,
    );

    if (!previousFuel) return null;

    // Only what the consumption reads. The whole row went out: a driver got
    // a colleague's refueling of the same truck (who, notes, price, photo),
    // and feeding its date back in walked the vehicle's history, which the
    // history route no longer shows them (DRV-SCOPE-1).
    return {
      vehicleId: previousFuel.vehicleId,
      refueling_date: previousFuel.refueling_date,
      current_mileage: previousFuel.current_mileage,
      liters_amount: Number(previousFuel.liters_amount),
    };
  }
}

export { GetPreviousFuelUseCase };
