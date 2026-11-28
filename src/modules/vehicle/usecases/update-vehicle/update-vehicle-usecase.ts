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
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { VehicleTypeNotFoundError } from "@/modules/vehicle-type/usecases/errors/vehicle-type-not-found-error";
import { FuelTypeNotFoundError } from "@/modules/fuel-type/usecases/errors/fuel-type-not-found-error";

import { DriverNotFoundError } from "@/modules/driver/usecases/errors/driver-not-found-error";
import { DriverNotBelongBusinessError } from "@/modules/driver/usecases/errors/driver-not-belong-business-error";
import { BranchNotFoundError } from "@/modules/branch/usecases/errors/branch-not-found-error";

import { VehicleNotFoundError } from "../errors/vehicle-not-found-error";
import { VehicleNotBelongBusinessError } from "../errors/vehicle-not-belong-business-error";

import { VehicleAlreadyExistsError } from "../errors/vehicle-already-exists-error";
import { VehicleRenavamExistsError } from "../errors/vehicle-renavam-exists-error";

import { VehicleTypeNotBelongBusinessError } from "@/modules/vehicle-type/usecases/errors/vehicle-type-not-belong-business-error";
import { FuelTypeNotBelongBusinessError } from "@/modules/fuel-type/usecases/errors/fuel-type-not-belong-business-error";

import { Vehicle, UpdateVehicleProps } from "../../dtos/vehicle-dto";
import { VehicleModelYearError } from "../errors/vehicle-model-year-error";

import { BranchNotBelongBusinessError } from "@/modules/branch/usecases/errors/branch-not-belong-business-error";
import { VehicleCurrentMileageCanNotBeUpdatedError } from "../errors/vehicle-current-mileage-can-not-be-updated";

import { translateVehicleStatus } from "@/shared/utils/format-values";
import {
  canReactivateVehicle,
  isVehicleLimitEnforced,
  occupiesFleetSlot,
} from "@/shared/entitlements/entitlement-rules";

import { AppError } from "@/shared/errors/AppError";

import {
  decideVehicleStatusChange,
  statusChangeNotice,
  type OpenRouteCounts,
} from "@/shared/vehicle/vehicle-status-change";
import { vehicleUniqueFieldOf } from "@/shared/vehicle/vehicle-conflicts";
import {
  isModelYearCoherent,
  vehicleYearOf,
  withVehicleDates,
} from "@/shared/vehicle/vehicle-years";
import { logger } from "@/shared/logging/logger";
import { sendCatalogChangedEvent } from "@/websocket";
import { assertResponsibleUser } from "../vehicle-responsible";

const log = logger.child({ component: "vehicle" });

interface UpdateVehicleResult {
  vehicle: Vehicle;

  /**
   * What the answer says instead of "atualizado", when the status change
   * touches the vehicle's routes (statusChangeNotice); null otherwise.
   */
  notice: string | null;
}

@injectable()
class UpdateVehicleUseCase {
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
    vehicleData: UpdateVehicleProps,
    vehicleId: string,
    businessId: string,
    userId: string,
  ): Promise<UpdateVehicleResult> {
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

    const findVehicle = await this.vehicle.findVehicleById(vehicleId);

    if (!findVehicle) {
      throw new VehicleNotFoundError();
    }

    if (findVehicle.businessId !== businessId) {
      throw new VehicleNotBelongBusinessError();
    }

    const changes: UpdateVehicleProps = { ...vehicleData };

    if (changes.license_plate !== undefined) {
      changes.license_plate = changes.license_plate.trim().toUpperCase();
    }

    // The column is NOT NULL: a null here means "not sent", never "erase".
    if (changes.current_mileage === null) {
      delete changes.current_mileage;
    }

    if (
      findUser.role !== "MASTER" &&
      changes.current_mileage !== undefined &&
      changes.current_mileage !== findVehicle.current_mileage
    ) {
      throw new VehicleCurrentMileageCanNotBeUpdatedError();
    }

    // The status against the routes that use the vehicle (decision 8.3).
    // Counted only when the status really changes: an echo costs nothing.
    const requestedStatus = changes.status;
    let openRoutes: OpenRouteCounts | null = null;
    let fromRunningRoute = false;

    if (changes.status !== undefined && changes.status !== findVehicle.status) {
      openRoutes = await this.vehicle.countOpenRoutesForVehicle(
        vehicleId,
        businessId,
      );

      const verdict = decideVehicleStatusChange({
        current: findVehicle.status,
        requested: changes.status,
        openRoutes,
      });

      if (verdict.kind === "refused") {
        throw new AppError(
          verdict.message,
          verdict.code === "VEHICLE_STATUS_DERIVED" ? 400 : 409,
          verdict.code,
        );
      }

      // What the rule decided is what is written: unblocking a truck on the
      // road writes "Em rota", not the ACTIVE the form sent — derived again
      // in the write itself, under the running route's lock, since the
      // route may end between the count above and the write.
      if (verdict.kind === "allowed") {
        changes.status = verdict.status;
        fromRunningRoute = "fromRunningRoute" in verdict;
      }
    } else {
      // An older client resends the stored status (IN_ROUTE included) with
      // an unrelated edit; that is no change, not a request to lie.
      delete changes.status;
    }

    if (
      changes.license_plate &&
      changes.license_plate !== findVehicle.license_plate
    ) {
      const findVehicleByLicensePlate =
        await this.vehicle.findVehicleByLicensePlate(
          changes.license_plate,
          businessId,
        );

      if (
        findVehicleByLicensePlate &&
        findVehicleByLicensePlate.id !== vehicleId
      ) {
        throw new VehicleAlreadyExistsError();
      }
    }

    if (changes.renavam && changes.renavam !== findVehicle.renavam) {
      const findVehicleByRenavam = await this.vehicle.findVehicleByRenavam(
        changes.renavam,
        businessId,
      );

      if (findVehicleByRenavam && findVehicleByRenavam.id !== vehicleId) {
        throw new VehicleRenavamExistsError();
      }
    }

    if (changes.vehicleTypeId) {
      const findVehicleType = await this.vehicleType.findVehicleTypeById(
        changes.vehicleTypeId,
      );

      if (!findVehicleType) {
        throw new VehicleTypeNotFoundError();
      }

      if (findVehicleType.businessId !== businessId) {
        throw new VehicleTypeNotBelongBusinessError();
      }
    }

    if (changes.fuelTypeId) {
      const findFuelType = await this.fuelType.findFuelTypeById(
        changes.fuelTypeId,
      );

      if (!findFuelType) {
        throw new FuelTypeNotFoundError();
      }

      if (findFuelType.businessId !== businessId) {
        throw new FuelTypeNotBelongBusinessError();
      }
    }

    // Pairs are judged only when the edit touches them, one side possibly
    // coming from the row: an unrelated edit must not be refused over data
    // that was accepted when it was written.
    if (changes.manufacturing_year || changes.model_year) {
      const manufacturingYear = vehicleYearOf(
        changes.manufacturing_year ?? findVehicle.manufacturing_year,
      );
      const modelYear = vehicleYearOf(
        changes.model_year ?? findVehicle.model_year,
      );

      if (!isModelYearCoherent(manufacturingYear, modelYear)) {
        throw new VehicleModelYearError();
      }
    }

    const currentMileage =
      changes.current_mileage ?? findVehicle.current_mileage;
    const lastMaintenanceMileage =
      changes.last_maintenance_mileage !== undefined
        ? changes.last_maintenance_mileage
        : findVehicle.last_maintenance_mileage;

    if (
      (changes.current_mileage != null ||
        changes.last_maintenance_mileage != null) &&
      typeof lastMaintenanceMileage === "number" &&
      lastMaintenanceMileage > currentMileage
    ) {
      throw new AppError(
        "A quilometragem da última revisão não pode ser superior à quilometragem atual.",
        400,
        "VEHICLE_MAINTENANCE_MILEAGE_INVALID",
      );
    }

    if (changes.driverId) {
      const findDriver = await this.driver.findDriverById(changes.driverId);

      if (!findDriver) {
        throw new DriverNotFoundError();
      }

      // The DRIVER is the foreign record here (FLEET-VEH-9); this used to
      // answer that the vehicle did not belong to the company.
      if (findDriver.businessId !== businessId) {
        throw new DriverNotBelongBusinessError();
      }
    }

    if (changes.branchId) {
      const findBranch = await this.branch.findBranchById(changes.branchId);

      if (!findBranch) {
        throw new BranchNotFoundError();
      }

      if (findBranch.businessId !== businessId) {
        throw new BranchNotBelongBusinessError();
      }
    }

    // F1: only a person the edit actually changes to is checked; null hands
    // the vehicle back to the admins, absent keeps who it is.
    if (changes.responsibleUserId !== findVehicle.responsibleUserId) {
      await assertResponsibleUser(
        this.user,
        changes.responsibleUserId,
        businessId,
      );
    }

    // Reactivating an INACTIVE vehicle re-occupies a contracted slot, so it
    // passes the same locked count as a new registration (FLEET-VEH-7).
    // Every status that takes a slot goes through it, and the repository
    // decides there, under the company's lock, whether the vehicle already
    // holds one (M8): `findVehicle` is older, and an inactivation plus a new
    // registration in between turned an unblocking into an uncounted
    // reactivation. The unblocking on the road passes through it as well
    // (IN_ROUTE and BLOCKED both hold a slot, so it is never refused, but
    // the row is read as it is under the lock).
    const takesSlot =
      changes.status !== undefined && occupiesFleetSlot(changes.status);

    const statusFromRunningRoute = fromRunningRoute
      ? { businessId }
      : undefined;

    const limit = findBusiness.vehicle_limit ?? 0;

    let updatedVehicle: Vehicle | null;
    let activeCount = 0;

    try {
      if (takesSlot && isVehicleLimitEnforced(limit)) {
        ({ vehicle: updatedVehicle, activeCount } =
          await this.vehicle.updateVehicleWithinLimit(
            {
              vehicleData: withVehicleDates(changes),
              vehicleId,
              businessId,
              statusFromRunningRoute,
            },
            { max: limit },
          ));
      } else {
        updatedVehicle = await this.vehicle.updateVehicle({
          vehicleData: withVehicleDates(changes),
          vehicleId,
          statusFromRunningRoute,
        });
      }
    } catch (error) {
      const conflict = vehicleUniqueFieldOf(error);

      if (conflict === "license_plate") throw new VehicleAlreadyExistsError();
      if (conflict === "renavam") throw new VehicleRenavamExistsError();

      log.error({ err: error }, "vehicle_update_failed");

      throw new AppError(
        "Houve um erro ao tentar atualizar o veículo! Por favor, tente novamente.",
        500,
      );
    }

    if (!updatedVehicle) {
      const verdict = canReactivateVehicle(activeCount, limit);

      throw new AppError(
        verdict.reason ?? "Limite de veículos contratados atingido.",
        409,
        "VEHICLE_LIMIT_REACHED",
      );
    }

    sendCatalogChangedEvent(businessId, "vehicle");

    this.notificationService.createActivityIfEnabled({
      type: "Veículo",
      action: "update",
      entityId: vehicleId,
      description: `Veículo ${updatedVehicle.license_plate} atualizado | ID: ${updatedVehicle.id}`,
      status: translateVehicleStatus(updatedVehicle.status) || "Atualizado",
      performedBy: userId,
      businessId,
    });

    return {
      vehicle: updatedVehicle,
      notice:
        requestedStatus && openRoutes
          ? statusChangeNotice({
              requested: requestedStatus,
              written: updatedVehicle.status,
              openRoutes,
            })
          : null,
    };
  }
}

export { UpdateVehicleUseCase };
export type { UpdateVehicleResult };
