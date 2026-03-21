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
import { translateVehicleStatus } from "@/shared/utils/format-values";

import { Vehicle, CreateVehicleProps } from "../../dtos/vehicle-dto";
import { VehicleModelYearError } from "../errors/vehicle-model-year-error";

import { FuelTypeNotBelongBusinessError } from "@/modules/fuel-type/usecases/errors/fuel-type-not-belong-business-error";

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

    const findBusiness = await this.business.findBusinessById(
      vehicleData.businessId,
    );

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    // Check if the board already exists
    const findVehicleByLicensePlate =
      await this.vehicle.findVehicleByLicensePlate(vehicleData.license_plate);

    if (findVehicleByLicensePlate) {
      throw new VehicleAlreadyExistsError();
    }

    // Check if RENAVAM already exists
    const findVehicleByRenavam = await this.vehicle.findVehicleByRenavam(
      vehicleData.renavam,
    );

    if (findVehicleByRenavam) {
      throw new VehicleRenavamExistsError();
    }

    // Additional checks for relationships
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

    const manufacturingDate = new Date(vehicleData.manufacturing_year);
    const modelDate = new Date(vehicleData.model_year);

    const manufacturingYear = manufacturingDate.getFullYear();
    const modelYear = modelDate.getFullYear();

    if (modelYear < manufacturingYear || modelYear > manufacturingYear + 1) {
      throw new VehicleModelYearError();
    }

    // Driver is optional
    if (vehicleData.driverId) {
      const findDriver = await this.driver.findDriverById(vehicleData.driverId);

      if (!findDriver) {
        throw new DriverNotFoundError();
      }

      if (findDriver.businessId !== vehicleData.businessId) {
        throw new DriverNotBelongBusinessError();
      }
    }

    // Branch is optional
    if (vehicleData.branchId) {
      const findBranch = await this.branch.findBranchById(vehicleData.branchId);

      if (!findBranch) {
        throw new BranchNotFoundError();
      }

      if (findBranch.businessId !== vehicleData.businessId) {
        throw new BranchNotBelongBusinessError();
      }
    }

    try {
      const vehicleCreated = await this.vehicle.createVehicle(vehicleData);

      // Process activity asynchronously without blocking the main flow
      this.notificationService.createActivityIfEnabled({
        type: "Veículo",
        action: "create",
        entityId: vehicleCreated.id,
        description: `Veículo ${vehicleCreated.license_plate} criado | ID: ${vehicleCreated.id}`,
        status: translateVehicleStatus(vehicleCreated.status),
        performedBy: userId,
        businessId: vehicleData.businessId,
      });

      return vehicleCreated;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar criar o veículo! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { CreateVehicleUseCase };
