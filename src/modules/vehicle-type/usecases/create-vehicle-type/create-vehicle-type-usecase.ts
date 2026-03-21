import { inject, injectable } from "tsyringe";

import { IVehicleTypeRepository } from "@/modules/vehicle-type/repositories/IVehicle-type-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { AppError } from "@/shared/errors/AppError";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { NotificationService } from "@/shared/services/notification-service";

import { VehicleTypeAlreadyExistsError } from "../errors/vehicle-type-already-exists-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import {
  VehicleType,
  CreateVehicleTypeProps,
} from "../../dtos/vehicle-type-dto";

@injectable()
class CreateVehicleTypeUseCase {
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
    vehicleTypeData: CreateVehicleTypeProps,
    userId: string,
  ): Promise<VehicleType> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findBusiness = await this.business.findBusinessById(
      vehicleTypeData.businessId,
    );

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    const findVehicleTypeByDescription =
      await this.vehicleType.findVehicleTypeByDescription(
        vehicleTypeData.description,
        vehicleTypeData.businessId,
      );

    if (findVehicleTypeByDescription) {
      throw new VehicleTypeAlreadyExistsError();
    }

    try {
      const vehicleTypeCreated =
        await this.vehicleType.createVehicleType(vehicleTypeData);

      // Process activity asynchronously without blocking the main flow
      this.notificationService.createActivityIfEnabled({
        type: "Tipo de veículo",
        action: "create",
        entityId: vehicleTypeCreated.id,
        description: `Tipo de veículo criado com sucesso: ${vehicleTypeCreated.description} | Eixos: ${vehicleTypeCreated.number_of_axles} | ID: ${vehicleTypeCreated.id}`,
        status: "Completo",
        performedBy: userId,
        businessId: vehicleTypeData.businessId,
      });

      return vehicleTypeCreated;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar criar o tipo de veículo! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { CreateVehicleTypeUseCase };
