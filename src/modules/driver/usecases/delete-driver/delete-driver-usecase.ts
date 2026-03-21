import { inject, injectable } from "tsyringe";

import { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IFineRepository } from "@/modules/fine/repositories/IFine-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { AppError } from "@/shared/errors/AppError";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { DriverNotBelongBusinessError } from "../errors/driver-not-belong-business-error";
import { DriverNotFoundError } from "../errors/driver-not-found-error";

import { NotificationService } from "@/shared/services/notification-service";

import { DriverHasAssociatedFinesError } from "../errors/driver-has-associated-fines-error";
import { DriverHasAssociatedFuelError } from "../errors/driver-has-associated-fuel-error";

import { DriverHasAssociatedChecklistsError } from "../errors/driver-has-associated-checklists-error";
import { DriverHasAssociatedUserError } from "../errors/driver-has-associated-user-error";

import { IFuelRepository } from "@/modules/fuel/repositories/IFuel-repository";
import { IVehicleChecklistRepository } from "@/modules/vehicle-checklist/repositories/IVehicle-checklist-repository";

import { Driver } from "../../dtos/driver-dto";

@injectable()
class DeleteDriverUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("DriverRepository")
    private driver: IDriverRepository,
    @inject("FineRepository")
    private fine: IFineRepository,
    @inject("FuelRepository")
    private fuel: IFuelRepository,
    @inject("VehicleChecklistRepository")
    private vehicleChecklist: IVehicleChecklistRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute(
    driverId: string,
    userId: string,
    businessId: string,
  ): Promise<Driver> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findBusiness = await this.business.findBusinessById(businessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    const findDriverById = await this.driver.findDriverById(driverId);

    if (!findDriverById) {
      throw new DriverNotFoundError();
    }

    if (findDriverById.businessId !== businessId) {
      throw new DriverNotBelongBusinessError();
    }

    // Check if driver is linked to a user account
    const linkedUser = await this.user.findUserByDriverId(driverId);

    if (linkedUser) {
      throw new DriverHasAssociatedUserError();
    }

    const associatedFines = await this.fine.findFinesByDriverId(driverId);

    if (associatedFines.length > 0) {
      throw new DriverHasAssociatedFinesError(associatedFines.length);
    }

    const associatedFuels = await this.fuel.findFuelsByDriverId(driverId);

    if (associatedFuels.length > 0) {
      throw new DriverHasAssociatedFuelError(associatedFuels.length);
    }

    const associatedChecklists =
      await this.vehicleChecklist.findVehicleChecklistsByDriverId(driverId);

    if (associatedChecklists.length > 0) {
      throw new DriverHasAssociatedChecklistsError(associatedChecklists.length);
    }

    try {
      const driverDeleted = await this.driver.deleteDriver(driverId);

      // Process activity asynchronously without blocking the main flow
      this.notificationService.createActivityIfEnabled({
        type: "Motorista",
        action: "delete",
        entityId: driverDeleted.id,
        description: `Motorista excluído: ${driverDeleted.name} | CNH: ${driverDeleted.cnh} | ID: ${driverDeleted.id}`,
        status: "Deletado",
        performedBy: userId,
        businessId: businessId,
      });

      return driverDeleted;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar deletar o motorista! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { DeleteDriverUseCase };
