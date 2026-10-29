import { inject, injectable } from "tsyringe";

import { IFuelTypeRepository } from "@/modules/fuel-type/repositories/IFuel-type-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { AppError } from "@/shared/errors/AppError";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { NotificationService } from "@/shared/services/notification-service";

import { FuelTypeNotFoundError } from "../errors/fuel-type-not-found-error";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";
import { sendCatalogChangedEvent } from "@/websocket";

import { FuelTypeHasAssociatedVehiclesError } from "../errors/fuel-type-has-associated-vehicles-error";
import { FuelTypeHasAssociatedFuelError } from "../errors/fuel-type-has-associated-fuel-error";

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

    assertTenantAccess(findUser, businessId);

    const findBusiness = await this.business.findBusinessById(businessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    // Another company's fuel type answers as missing: a distinct refusal
    // told the caller that the id exists somewhere else.
    const findFuelType = await this.fuelType.findFuelTypeByIdAndBusiness(
      fuelTypeId,
      businessId,
    );

    if (!findFuelType) {
      throw new FuelTypeNotFoundError();
    }

    // Counted, not loaded: the old guard read every refueling of the fuel
    // (thousands) to take `.length`.
    const usage = await this.fuelType.countFuelTypeUsage(fuelTypeId);

    if (usage.vehicles > 0) {
      throw new FuelTypeHasAssociatedVehiclesError(usage.vehicles);
    }

    if (usage.fuels > 0) {
      throw new FuelTypeHasAssociatedFuelError(usage.fuels);
    }

    try {
      const fuelTypeDeleted = await this.fuelType.deleteFuelType(fuelTypeId);

      // After the write: open pickers of this company drop it (decision 2.3).
      sendCatalogChangedEvent(businessId, "fuel_type");

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
