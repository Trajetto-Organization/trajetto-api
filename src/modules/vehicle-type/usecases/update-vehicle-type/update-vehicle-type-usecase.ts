import { inject, injectable } from "tsyringe";

import { IVehicleTypeRepository } from "@/modules/vehicle-type/repositories/IVehicle-type-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { AppError } from "@/shared/errors/AppError";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { VehicleTypeNotFoundError } from "../errors/vehicle-type-not-found-error";
import { VehicleTypeAlreadyExistsError } from "../errors/vehicle-type-already-exists-error";

import { NotificationService } from "@/shared/services/notification-service";
import {
  VehicleType,
  UpdateVehicleTypeProps,
} from "../../dtos/vehicle-type-dto";
import { sendCatalogChangedEvent } from "@/websocket";
import { isUniqueViolation } from "@/shared/vehicle/vehicle-conflicts";
import { logger } from "@/shared/logging/logger";

const log = logger.child({ component: "vehicle-type" });

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

    // The caller's own company, not only the route guard: a job or another
    // use case reaches this without the HTTP tenant check.
    assertTenantAccess(findUser, businessId);

    const findBusiness = await this.business.findBusinessById(businessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    // Looked up WITH the company of the path. It used to be looked up with a
    // body field the schema strips (so by id alone), and the write then
    // stamped the path's company on the row: a MASTER editing through the
    // wrong company moved the type, and the vehicles pointing at it, across
    // tenants.
    const findVehicleType =
      await this.vehicleType.findVehicleTypeByIdAndBusiness(
        vehicleTypeId,
        businessId,
      );

    if (!findVehicleType) {
      throw new VehicleTypeNotFoundError();
    }

    if (
      vehicleTypeData.description &&
      vehicleTypeData.description.toLowerCase() !==
        findVehicleType.description.toLowerCase()
    ) {
      const findVehicleTypeByDescription =
        await this.vehicleType.findVehicleTypeByDescription(
          vehicleTypeData.description,
          businessId,
        );

      if (
        findVehicleTypeByDescription &&
        findVehicleTypeByDescription.id !== vehicleTypeId
      ) {
        throw new VehicleTypeAlreadyExistsError();
      }
    }

    let vehicleTypeUpdated: VehicleType;

    try {
      vehicleTypeUpdated = await this.vehicleType.updateVehicleType({
        vehicleTypeData: {
          description: vehicleTypeData.description ?? undefined,
          number_of_axles: vehicleTypeData.number_of_axles,
          required_cnh_category: vehicleTypeData.required_cnh_category,
        },
        vehicleTypeId,
      });
    } catch (error) {
      // A rename racing another request for the same name. Ready for the
      // per-company name index (FLEET-DUP-1, not created yet): once it
      // exists it answers here, and it can only be this company's type.
      if (isUniqueViolation(error)) throw new VehicleTypeAlreadyExistsError();

      log.error({ err: error }, "vehicle_type_update_failed");

      throw new AppError(
        "Houve um erro ao tentar atualizar o tipo de veículo! Por favor, tente novamente.",
        500,
      );
    }

    sendCatalogChangedEvent(businessId, "vehicle_type");

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
  }
}

export { UpdateVehicleTypeUseCase };
