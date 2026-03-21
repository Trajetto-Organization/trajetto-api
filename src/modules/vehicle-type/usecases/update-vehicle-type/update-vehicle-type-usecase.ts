import { inject, injectable } from "tsyringe";

import { IVehicleTypeRepository } from "@/modules/vehicle-type/repositories/IVehicle-type-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { AppError } from "@/shared/errors/AppError";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { VehicleTypeNotFoundError } from "../errors/vehicle-type-not-found-error";

import { VehicleTypeAlreadyExistsError } from "../errors/vehicle-type-already-exists-error";
import { VehicleTypeNotBelongBusinessError } from "../errors/vehicle-type-not-belong-business-error";

import { NotificationService } from "@/shared/services/notification-service";
import {
  VehicleType,
  UpdateVehicleTypeProps,
} from "../../dtos/vehicle-type-dto";

@injectable()
class UpdateVehicleTypeUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("VehicleTypeRepository")
    private vehicleType: IVehicleTypeRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute(
    vehicleTypeData: UpdateVehicleTypeProps,
    vehicleTypeId: string,
    userId: string,
    businessId: string,
  ): Promise<VehicleType> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findBusiness = await this.business.findBusinessById(businessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    const findVehicleTypeByIdAndBusiness =
      await this.vehicleType.findVehicleTypeByIdAndBusiness(
        vehicleTypeId,
        vehicleTypeData.businessId as string,
      );

    if (!findVehicleTypeByIdAndBusiness) {
      throw new VehicleTypeNotFoundError();
    }

    if (
      findVehicleTypeByIdAndBusiness.businessId !== businessId &&
      findUser.role !== "MASTER"
    ) {
      throw new VehicleTypeNotBelongBusinessError();
    }

    // Checks if there is already another type of vehicle with the same description (if the description is being changed)
    if (
      vehicleTypeData.description ||
      businessId !== findVehicleTypeByIdAndBusiness.businessId
    ) {
      const descriptionToCheck =
        vehicleTypeData.description ||
        findVehicleTypeByIdAndBusiness.description;

      const findVehicleTypeByDescription =
        await this.vehicleType.findVehicleTypeByDescription(
          descriptionToCheck,
          businessId,
        );

      if (
        findVehicleTypeByDescription &&
        findVehicleTypeByDescription.id !== vehicleTypeId
      ) {
        throw new VehicleTypeAlreadyExistsError();
      }
    }

    try {
      const vehicleTypeUpdated = await this.vehicleType.updateVehicleType({
        vehicleTypeData: {
          description: vehicleTypeData.description,
          number_of_axles: vehicleTypeData.number_of_axles,
          businessId,
        },
        vehicleTypeId,
      });

      // Process activity asynchronously without blocking the main flow
      this.notificationService.createActivityIfEnabled({
        type: "Tipo de veículo",
        action: "update",
        entityId: vehicleTypeUpdated.id,
        description: `Tipo de veículo atualizado com sucesso: ${vehicleTypeUpdated.description} | Eixos: ${vehicleTypeUpdated.number_of_axles} | ID: ${vehicleTypeUpdated.id}`,
        status: "Atualizado",
        performedBy: userId,
        businessId: businessId,
      });

      return vehicleTypeUpdated;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar atualizar o tipo de veículo! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { UpdateVehicleTypeUseCase };
