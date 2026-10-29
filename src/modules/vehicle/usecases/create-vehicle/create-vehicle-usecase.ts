import { inject, injectable } from "tsyringe";
import { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IVehicleTypeRepository } from "@/modules/vehicle-type/repositories/IVehicle-type-repository";
import { IFuelTypeRepository } from "@/modules/fuel-type/repositories/IFuel-type-repository";

import { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";
import { IBranchRepository } from "@/modules/branch/repositories/IBranch-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { NotificationService } from "@/shared/services/notification-service";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";
import { VehicleAlreadyExistsError } from "../errors/vehicle-already-exists-error";

import { VehicleTypeNotFoundError } from "@/modules/vehicle-type/usecases/errors/vehicle-type-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { FuelTypeNotFoundError } from "@/modules/fuel-type/usecases/errors/fuel-type-not-found-error";
import { DriverNotFoundError } from "@/modules/driver/usecases/errors/driver-not-found-error";

import { BranchNotFoundError } from "@/modules/branch/usecases/errors/branch-not-found-error";

import { VehicleRenavamExistsError } from "../errors/vehicle-renavam-exists-error";
import { VehicleTypeNotBelongBusinessError } from "@/modules/vehicle-type/usecases/errors/vehicle-type-not-belong-business-error";

import { DriverNotBelongBusinessError } from "@/modules/driver/usecases/errors/driver-not-belong-business-error";
import { BranchNotBelongBusinessError } from "@/modules/branch/usecases/errors/branch-not-belong-business-error";

import { AppError } from "@/shared/errors/AppError";
import {
  canRegisterVehicle,
  occupiesFleetSlot,
} from "@/shared/entitlements/entitlement-rules";
import { translateVehicleStatus } from "@/shared/utils/format-values";

import { Vehicle, CreateVehicleProps } from "../../dtos/vehicle-dto";
import { VehicleModelYearError } from "../errors/vehicle-model-year-error";

import { FuelTypeNotBelongBusinessError } from "@/modules/fuel-type/usecases/errors/fuel-type-not-belong-business-error";

import { vehicleUniqueFieldOf } from "@/shared/vehicle/vehicle-conflicts";
import {
  isModelYearCoherent,
  vehicleYearOf,
  withVehicleDates,
} from "@/shared/vehicle/vehicle-years";
import { logger } from "@/shared/logging/logger";
import { sendCatalogChangedEvent } from "@/websocket";

const log = logger.child({ component: "vehicle" });

@injectable()
class CreateVehicleUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("VehicleTypeRepository")
    private vehicleType: IVehicleTypeRepository,
    @inject("FuelTypeRepository")
    private fuelType: IFuelTypeRepository,
    @inject("DriverRepository")
    private driver: IDriverRepository,
    @inject("BranchRepository")
    private branch: IBranchRepository,
    @inject("VehicleRepository")
    private vehicle: IVehicleRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute(
    vehicleData: CreateVehicleProps,
    userId: string,
  ): Promise<Vehicle> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    // The caller's own company, not only the route guard: a job or another
    // use case reaches this without the HTTP tenant check.
    assertTenantAccess(findUser, vehicleData.businessId);

    const findBusiness = await this.business.findBusinessById(
      vehicleData.businessId,
    );

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    // Uppercased by the schema too; repeated here because the use case is
    // also reached without it (the spreadsheet import, the tests).
    const licensePlate = vehicleData.license_plate.trim().toUpperCase();

    // Per company, like the unique index (decision 8.1): a lookup across
    // companies refused a truck another carrier also runs, and said so.
    const findVehicleByLicensePlate =
      await this.vehicle.findVehicleByLicensePlate(
        licensePlate,
        vehicleData.businessId,
      );

    if (findVehicleByLicensePlate) {
      throw new VehicleAlreadyExistsError();
    }

    const findVehicleByRenavam = await this.vehicle.findVehicleByRenavam(
      vehicleData.renavam,
      vehicleData.businessId,
    );

    if (findVehicleByRenavam) {
      throw new VehicleRenavamExistsError();
    }

    if (vehicleData.vehicleTypeId) {
      const findVehicleType = await this.vehicleType.findVehicleTypeById(
        vehicleData.vehicleTypeId,
      );

      if (!findVehicleType) {
        throw new VehicleTypeNotFoundError();
      }

      if (findVehicleType.businessId !== vehicleData.businessId) {
        throw new VehicleTypeNotBelongBusinessError();
      }
    }

    // FuelType is mandatory
    const findFuelType = await this.fuelType.findFuelTypeById(
      vehicleData.fuelTypeId,
    );

    if (!findFuelType) {
      throw new FuelTypeNotFoundError();
    }

    if (findFuelType.businessId !== vehicleData.businessId) {
      throw new FuelTypeNotBelongBusinessError();
    }

    if (
      !isModelYearCoherent(
        vehicleYearOf(vehicleData.manufacturing_year),
        vehicleYearOf(vehicleData.model_year),
      )
    ) {
      throw new VehicleModelYearError();
    }

    if (vehicleData.driverId) {
      const findDriver = await this.driver.findDriverById(vehicleData.driverId);

      if (!findDriver) {
        throw new DriverNotFoundError();
      }

      if (findDriver.businessId !== vehicleData.businessId) {
        throw new DriverNotBelongBusinessError();
      }
    }

    if (vehicleData.branchId) {
      const findBranch = await this.branch.findBranchById(vehicleData.branchId);

      if (!findBranch) {
        throw new BranchNotFoundError();
      }

      if (findBranch.businessId !== vehicleData.businessId) {
        throw new BranchNotBelongBusinessError();
      }
    }

    let created: Vehicle | null;
    let activeCount: number;

    try {
      ({ vehicle: created, activeCount } =
        await this.vehicle.createVehicleWithinLimit(
          withVehicleDates({ ...vehicleData, license_plate: licensePlate }),
          {
            max: findBusiness.vehicle_limit ?? 0,
            occupiesSlot: occupiesFleetSlot(vehicleData.status),
          },
        ));
    } catch (error) {
      // Two requests for the same plate can both pass the lookup above; the
      // second one meets the per-company index. Only the column is read, so
      // nothing of the conflicting row is disclosed.
      const conflict = vehicleUniqueFieldOf(error);

      if (conflict === "license_plate") throw new VehicleAlreadyExistsError();
      if (conflict === "renavam") throw new VehicleRenavamExistsError();

      // The cause stays in the log; the client gets a sentence it can show.
      log.error({ err: error }, "vehicle_create_failed");

      throw new AppError(
        "Houve um erro ao tentar criar o veículo! Por favor, tente novamente.",
        500,
      );
    }

    // Outside the try on purpose (FLEET-VEH-1): the refusal used to be
    // thrown inside it, and the generic catch turned "Limite de veículos
    // contratados atingido (9/10)" into a 500 "Houve um erro".
    if (!created) {
      const verdict = canRegisterVehicle(
        activeCount,
        findBusiness.vehicle_limit ?? 0,
      );

      throw new AppError(
        verdict.reason ?? "Limite de veículos contratados atingido.",
        409,
        "VEHICLE_LIMIT_REACHED",
      );
    }

    // After the commit: pickers open in other sessions refetch (decision 2.3).
    sendCatalogChangedEvent(vehicleData.businessId, "vehicle");

    this.notificationService.createActivityIfEnabled({
      type: "Veículo",
      action: "create",
      entityId: created.id,
      description: `Veículo ${created.license_plate} criado | ID: ${created.id}`,
      status: translateVehicleStatus(created.status),
      performedBy: userId,
      businessId: vehicleData.businessId,
    });

    return created;
  }
}

export { CreateVehicleUseCase };
