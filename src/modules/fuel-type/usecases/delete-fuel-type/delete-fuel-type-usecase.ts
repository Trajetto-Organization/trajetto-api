import { inject, injectable } from "tsyringe";

import { IFuelTypeRepository } from "@/modules/fuel-type/repositories/IFuel-type-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { AppError } from "@/shared/errors/AppError";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { NotificationService } from "@/shared/services/notification-service";

import { FuelTypeNotFoundError } from "../errors/fuel-type-not-found-error";
import { FuelTypeNotBelongBusinessError } from "../errors/fuel-type-not-belong-business-error";

import { FuelTypeHasAssociatedVehiclesError } from "../errors/fuel-type-has-associated-vehicles-error";
import { FuelTypeHasAssociatedFuelError } from "../errors/fuel-type-has-associated-fuel-error";

import { IFuelRepository } from "@/modules/fuel/repositories/IFuel-repository";
import { FuelType } from "../../dtos/fuel-type-dto";

@injectable()
class DeleteFuelTypeUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("FuelTypeRepository")
    private fuelType: IFuelTypeRepository,
    @inject("VehicleRepository")
    private vehicle: IVehicleRepository,
    @inject("FuelRepository")
    private fuel: IFuelRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute(
    fuelTypeId: string,
    userId: string,
    businessId: string,
  ): Promise<FuelType> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findBusiness = await this.business.findBusinessById(businessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    const findFuelTypeById = await this.fuelType.findFuelTypeById(fuelTypeId);

    if (!findFuelTypeById) {
      throw new FuelTypeNotFoundError();
    }

    if (findFuelTypeById.businessId !== businessId) {
      throw new FuelTypeNotBelongBusinessError();
    }

    const associatedVehicles =
      await this.vehicle.findVehiclesByFuelTypeId(fuelTypeId);

    if (associatedVehicles.length > 0) {
      throw new FuelTypeHasAssociatedVehiclesError(associatedVehicles.length);
    }

    const associatedFuels = await this.fuel.findFuelsByFuelTypeId(fuelTypeId);

    if (associatedFuels.length > 0) {
      throw new FuelTypeHasAssociatedFuelError(associatedFuels.length);
    }

    try {
      const fuelTypeDeleted = await this.fuelType.deleteFuelType(fuelTypeId);

      // Process activity asynchronously without blocking the main flow
      this.notificationService.createActivityIfEnabled({
        type: "Tipo de combustível",
        action: "delete",
        entityId: fuelTypeDeleted.id,
        description: `Tipo de combustível excluído: ${fuelTypeDeleted.description} | ID: ${fuelTypeDeleted.id}`,
        status: "Deletado",
        performedBy: userId,
        businessId: businessId,
      });

      return fuelTypeDeleted;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar deletar o tipo de combustível! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { DeleteFuelTypeUseCase };
