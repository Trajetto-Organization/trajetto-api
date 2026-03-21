import { inject, injectable } from "tsyringe";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { IVehicleTypeRepository } from "@/modules/vehicle-type/repositories/IVehicle-type-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { AppError } from "@/shared/errors/AppError";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { NotificationService } from "@/shared/services/notification-service";
import { VehicleTypeNotBelongBusinessError } from "../errors/vehicle-type-not-belong-business-error";

import { VehicleTypeNotFoundError } from "../errors/vehicle-type-not-found-error";
import { VehicleType } from "../../dtos/vehicle-type-dto";

@injectable()
class DeleteVehicleTypeUseCase {
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

    const findVehicleTypeById =
      await this.vehicleType.findVehicleTypeById(vehicleTypeId);

    if (!findVehicleTypeById) {
      throw new VehicleTypeNotFoundError();
    }

    if (findVehicleTypeById.businessId !== businessId) {
      throw new VehicleTypeNotBelongBusinessError();
    }

    try {
      const vehicleTypeDeleted =
        await this.vehicleType.deleteVehicleType(vehicleTypeId);

      // Process activity asynchronously without blocking the main flow
      this.notificationService.createActivityIfEnabled({
        type: "Tipo de veículo",
        action: "delete",
        entityId: vehicleTypeDeleted.id,
        description: `Tipo de veículo excluído: ${vehicleTypeDeleted.description} | Eixos: ${vehicleTypeDeleted.number_of_axles} | ID: ${vehicleTypeDeleted.id}`,
        status: "Deletado",
        performedBy: userId,
        businessId: businessId,
      });

      return vehicleTypeDeleted;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar deletar o tipo de veículo! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { DeleteVehicleTypeUseCase };
