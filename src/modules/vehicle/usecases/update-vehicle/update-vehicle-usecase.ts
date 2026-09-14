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
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { VehicleTypeNotFoundError } from "@/modules/vehicle-type/usecases/errors/vehicle-type-not-found-error";
import { FuelTypeNotFoundError } from "@/modules/fuel-type/usecases/errors/fuel-type-not-found-error";

import { DriverNotFoundError } from "@/modules/driver/usecases/errors/driver-not-found-error";
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
  occupiesFleetSlot,
} from "@/shared/entitlements/entitlement-rules";

import { AppError } from "@/shared/errors/AppError";

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
  ): Promise<Vehicle> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

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

    if (
      findUser.role !== "MASTER" &&
      vehicleData.current_mileage !== undefined &&
      vehicleData.current_mileage !== findVehicle.current_mileage
    ) {
      throw new VehicleCurrentMileageCanNotBeUpdatedError();
    }

    // Reactivating an INACTIVE vehicle re-occupies a contracted slot, so it
    // passes the same gate as a new registration (0 = limit not configured).
    const isReactivation =
      vehicleData.status !== undefined &&
      !occupiesFleetSlot(findVehicle.status) &&
      occupiesFleetSlot(vehicleData.status);

    if (isReactivation && (findBusiness.vehicle_limit ?? 0) > 0) {
      const activeCount =
        await this.vehicle.countActiveVehiclesByBusinessId(businessId);

      const verdict = canReactivateVehicle(
        activeCount,
        findBusiness.vehicle_limit ?? 0,
      );

      if (!verdict.allowed) {
        throw new AppError(verdict.reason!, 400, "VEHICLE_LIMIT_REACHED");
      }
    }

    // Check if license plate is being updated and if it already exists
    if (
      vehicleData.license_plate &&
      vehicleData.license_plate !== findVehicle.license_plate
    ) {
      const findVehicleByLicensePlate =
        await this.vehicle.findVehicleByLicensePlate(vehicleData.license_plate);

      if (findVehicleByLicensePlate) {
        throw new VehicleAlreadyExistsError();
      }
    }

    // Check if RENAVAM is being updated and if it already exists
    if (vehicleData.renavam && vehicleData.renavam !== findVehicle.renavam) {
      const findVehicleByRenavam = await this.vehicle.findVehicleByRenavam(
        vehicleData.renavam,
      );

      if (findVehicleByRenavam) {
        throw new VehicleRenavamExistsError();
      }
    }

    // Additional checks for relationships
    if (vehicleData.vehicleTypeId) {
      const findVehicleType = await this.vehicleType.findVehicleTypeById(
        vehicleData.vehicleTypeId,
      );

      if (!findVehicleType) {
        throw new VehicleTypeNotFoundError();
      }

      if (findVehicleType.businessId !== businessId) {
        throw new VehicleTypeNotBelongBusinessError();
      }
    }

    // FuelType is mandatory
    if (vehicleData.fuelTypeId) {
      const findFuelType = await this.fuelType.findFuelTypeById(
        vehicleData.fuelTypeId,
      );

      if (!findFuelType) {
        throw new FuelTypeNotFoundError();
      }

      if (findFuelType.businessId !== businessId) {
        throw new FuelTypeNotBelongBusinessError();
      }
    }

    // Validate relationship between model year and year of manufacture
    let manufacturingYear: number | null = null;
    let modelYear: number | null = null;

    // Determine the year of manufacture based on update data or existing vehicle
    if (vehicleData.manufacturing_year) {
      manufacturingYear = new Date(
        vehicleData.manufacturing_year,
      ).getFullYear();
    } else if (findVehicle.manufacturing_year) {
      manufacturingYear = new Date(
        findVehicle.manufacturing_year,
      ).getFullYear();
    }

    // Determine model year based on update data or existing vehicle
    if (vehicleData.model_year) {
      modelYear = new Date(vehicleData.model_year).getFullYear();
    } else if (findVehicle.model_year) {
      modelYear = new Date(findVehicle.model_year).getFullYear();
    }

    // If both years are known, validate the relationship between them
    if (manufacturingYear !== null && modelYear !== null) {
      if (modelYear < manufacturingYear || modelYear > manufacturingYear + 1) {
        throw new VehicleModelYearError();
      }
    }

    // Driver is optional
    if (vehicleData.driverId) {
      const findDriver = await this.driver.findDriverById(vehicleData.driverId);

      if (!findDriver) {
        throw new DriverNotFoundError();
      }

      if (findDriver.businessId !== businessId) {
        throw new VehicleNotBelongBusinessError();
      }
    }

    // Branch is optional
    if (vehicleData.branchId) {
      const findBranch = await this.branch.findBranchById(vehicleData.branchId);

      if (!findBranch) {
        throw new BranchNotFoundError();
      }

      if (findBranch.businessId !== businessId) {
        throw new BranchNotBelongBusinessError();
      }
    }

    try {
      const updatedVehicle = await this.vehicle.updateVehicle({
        vehicleData,
        vehicleId,
      });

      // Process activity asynchronously without blocking the main flow
      this.notificationService.createActivityIfEnabled({
        type: "Veículo",
        action: "update",
        entityId: vehicleId,
        description: `Veículo ${updatedVehicle.license_plate} atualizado | ID: ${updatedVehicle.id}`,
        status: translateVehicleStatus(updatedVehicle.status) || "Atualizado",
        performedBy: userId,
        businessId,
      });

      return updatedVehicle;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar atualizar o veículo! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { UpdateVehicleUseCase };
