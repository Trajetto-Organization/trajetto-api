import { inject, injectable } from "tsyringe";

import { IFuelTypeRepository } from "@/modules/fuel-type/repositories/IFuel-type-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { AppError } from "@/shared/errors/AppError";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { FuelTypeAlreadyExistsError } from "../errors/fuel-type-already-exists-error";

import { NotificationService } from "@/shared/services/notification-service";

import { FuelType, CreateFuelTypeProps } from "../../dtos/fuel-type-dto";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";
import { sendCatalogChangedEvent } from "@/websocket";

@injectable()
class CreateFuelTypeUseCase {
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
    fuelTypeData: CreateFuelTypeProps,
    userId: string,
  ): Promise<FuelType> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    // The route's tenant guard already refused another company's id; this
    // keeps the use case safe when called from anywhere else.
    assertTenantAccess(findUser, fuelTypeData.businessId);

    const findBusiness = await this.business.findBusinessById(
      fuelTypeData.businessId,
    );

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    const findFuelTypeByDescription =
      await this.fuelType.findFuelTypeByDescription(
        fuelTypeData.description,
        fuelTypeData.businessId,
      );

    if (findFuelTypeByDescription) {
      throw new FuelTypeAlreadyExistsError();
    }

    try {
      const fuelTypeCreated = await this.fuelType.createFuelType(fuelTypeData);

      // After the write: open pickers of this company refetch (decision 2.3).
      sendCatalogChangedEvent(fuelTypeData.businessId, "fuel_type");

      // Process activity asynchronously without blocking the main flow
      this.notificationService.createActivityIfEnabled({
        type: "Tipo de combustível",
        action: "create",
        entityId: fuelTypeCreated.id,
        description: `Tipo de combustível criado com sucesso: ${fuelTypeCreated.description} | ID: ${fuelTypeCreated.id}`,
        status: "Completo",
        performedBy: userId,
        businessId: fuelTypeData.businessId,
      });

      return fuelTypeCreated;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar criar o tipo de combustível! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { CreateFuelTypeUseCase };
