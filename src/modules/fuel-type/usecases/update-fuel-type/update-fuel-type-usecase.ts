import { inject, injectable } from "tsyringe";

import { IFuelTypeRepository } from "@/modules/fuel-type/repositories/IFuel-type-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { AppError } from "@/shared/errors/AppError";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { NotificationService } from "@/shared/services/notification-service";
import { FuelTypeAlreadyExistsError } from "../errors/fuel-type-already-exists-error";

import { FuelTypeNotFoundError } from "../errors/fuel-type-not-found-error";
import { FuelTypeNotBelongBusinessError } from "../errors/fuel-type-not-belong-business-error";

import { FuelType, UpdateFuelTypeProps } from "../../dtos/fuel-type-dto";

@injectable()
class UpdateFuelTypeUseCase {
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
    fuelTypeData: UpdateFuelTypeProps,
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

    const findFuelTypeByIdAndBusiness =
      await this.fuelType.findFuelTypeByIdAndBusiness(
        fuelTypeId,
        fuelTypeData.businessId as string,
      );

    if (!findFuelTypeByIdAndBusiness) {
      throw new FuelTypeNotFoundError();
    }

    if (
      findFuelTypeByIdAndBusiness.businessId !== businessId &&
      findUser.role !== "MASTER"
    ) {
      throw new FuelTypeNotBelongBusinessError();
    }

    if (
      fuelTypeData.description ||
      businessId !== findFuelTypeByIdAndBusiness.businessId
    ) {
      const descriptionToCheck =
        fuelTypeData.description || findFuelTypeByIdAndBusiness.description;

      const findFuelTypeByDescription =
        await this.fuelType.findFuelTypeByDescription(
          descriptionToCheck,
          businessId,
        );

      if (
        findFuelTypeByDescription &&
        findFuelTypeByDescription.id !== fuelTypeId
      ) {
        throw new FuelTypeAlreadyExistsError();
      }
    }

    try {
      const fuelTypeUpdated = await this.fuelType.updateFuelType({
        fuelTypeData: {
          description: fuelTypeData.description,
          businessId,
        },
        fuelTypeId,
      });

      // Process activity asynchronously without blocking the main flow
      this.notificationService.createActivityIfEnabled({
        type: "Tipo de combustível",
        action: "update",
        entityId: fuelTypeUpdated.id,
        description: `Tipo de combustível atualizado com sucesso: ${fuelTypeUpdated.description} | ID: ${fuelTypeUpdated.id}`,
        status: "Atualizado",
        performedBy: userId,
        businessId: businessId,
      });

      return fuelTypeUpdated;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar atualizar o tipo de combustível! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { UpdateFuelTypeUseCase };
