import { inject, injectable } from "tsyringe";

import { IVehicleTypeRepository } from "@/modules/vehicle-type/repositories/IVehicle-type-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { AppError } from "@/shared/errors/AppError";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";
import { NotificationService } from "@/shared/services/notification-service";

import { VehicleTypeAlreadyExistsError } from "../errors/vehicle-type-already-exists-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import {
  VehicleType,
  CreateVehicleTypeProps,
} from "../../dtos/vehicle-type-dto";
import { sendCatalogChangedEvent } from "@/websocket";
import { isUniqueViolation } from "@/shared/vehicle/vehicle-conflicts";
import { logger } from "@/shared/logging/logger";

const log = logger.child({ component: "vehicle-type" });

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

    // The caller's own company, not only the route guard: a job or another
    // use case reaches this without the HTTP tenant check.
    assertTenantAccess(findUser, vehicleTypeData.businessId);

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

    let vehicleTypeCreated: VehicleType;

    try {
      vehicleTypeCreated = await this.vehicleType.createVehicleType({
        description: vehicleTypeData.description,
        number_of_axles: vehicleTypeData.number_of_axles,
        required_cnh_category: vehicleTypeData.required_cnh_category ?? null,
        businessId: vehicleTypeData.businessId,
      });
    } catch (error) {
      // Two requests with the same name can both pass the lookup above.
      // VehicleType has no unique index yet: until the per-company name
      // index (FLEET-DUP-1) exists both succeed. Mapped ahead of it: that
      // index will be the table's only unique, so a P2002 can then only be
      // this conflict, in this company.
      if (isUniqueViolation(error)) throw new VehicleTypeAlreadyExistsError();

      log.error({ err: error }, "vehicle_type_create_failed");

      throw new AppError(
        "Houve um erro ao tentar criar o tipo de veículo! Por favor, tente novamente.",
        500,
      );
    }

    // After the commit: pickers open elsewhere refetch (decision 2.3).
    sendCatalogChangedEvent(vehicleTypeData.businessId, "vehicle_type");

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
  }
}

export { CreateVehicleTypeUseCase };
