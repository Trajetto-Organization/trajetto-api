import { inject, injectable } from "tsyringe";

import { IFuelTypeRepository } from "@/modules/fuel-type/repositories/IFuel-type-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { AppError } from "@/shared/errors/AppError";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { FuelTypeAlreadyExistsError } from "../errors/fuel-type-already-exists-error";

import { NotificationService } from "@/shared/services/notification-service";

import { FuelType, CreateFuelTypeProps } from "../../dtos/fuel-type-dto";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

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
