import { inject, injectable } from "tsyringe";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { IVehicleTypeRepository } from "@/modules/vehicle-type/repositories/IVehicle-type-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { AppError } from "@/shared/errors/AppError";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { NotificationService } from "@/shared/services/notification-service";

import { VehicleTypeNotFoundError } from "../errors/vehicle-type-not-found-error";
import { VehicleTypeInUseError } from "../errors/vehicle-type-in-use-error";
import { VehicleType } from "../../dtos/vehicle-type-dto";
import { sendCatalogChangedEvent } from "@/websocket";

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

    // The caller's own company, not only the route guard: a job or another
    // use case reaches this without the HTTP tenant check.
    assertTenantAccess(findUser, businessId);

    const findBusiness = await this.business.findBusinessById(businessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    // A type of another company answers like a missing one.
    const findVehicleType =
      await this.vehicleType.findVehicleTypeByIdAndBusiness(
        vehicleTypeId,
        businessId,
      );

    if (!findVehicleType) {
      throw new VehicleTypeNotFoundError();
    }

    const vehiclesUsingType =
      await this.vehicleType.countVehiclesUsingType(vehicleTypeId);

    if (vehiclesUsingType > 0) {
      throw new VehicleTypeInUseError(vehiclesUsingType);
    }

    let vehicleTypeDeleted: VehicleType;

    try {
      vehicleTypeDeleted =
        await this.vehicleType.deleteVehicleType(vehicleTypeId);
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar deletar o tipo de veículo! Por favor, tente novamente.",
        500,
      );
    }

    sendCatalogChangedEvent(businessId, "vehicle_type");

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
  }
}

export { DeleteVehicleTypeUseCase };
