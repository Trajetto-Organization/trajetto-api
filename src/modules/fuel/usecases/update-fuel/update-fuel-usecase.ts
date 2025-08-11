import { inject, injectable } from "tsyringe";
import { IFuelRepository } from "@/modules/fuel/repositories/IFuel-repository";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";

import { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";
import { IFuelTypeRepository } from "@/modules/fuel-type/repositories/IFuel-type-repository";

import { IBranchRepository } from "@/modules/branch/repositories/IBranch-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { NotificationService } from "@/shared/services/notification-service";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";
import { DriverNotFoundError } from "@/modules/driver/usecases/errors/driver-not-found-error";

import { FuelTypeNotFoundError } from "@/modules/fuel-type/usecases/errors/fuel-type-not-found-error";
import { BranchNotFoundError } from "@/modules/branch/usecases/errors/branch-not-found-error";

import { FuelNotFoundError } from "../errors/fuel-not-found-error";
import { FuelNotBelongBusinessError } from "../errors/fuel-not-belong-business-error";

import { VehicleNotBelongBusinessError } from "@/modules/vehicle/usecases/errors/vehicle-not-belong-business-error";
import { DriverNotBelongBusinessError } from "@/modules/driver/usecases/errors/driver-not-belong-business-error";

import { FuelTypeNotBelongBusinessError } from "@/modules/fuel-type/usecases/errors/fuel-type-not-belong-business-error";
import { BranchNotBelongBusinessError } from "@/modules/branch/usecases/errors/branch-not-belong-business-error";

import { VehicleMileageInvalidError } from "../errors/vehicle-mileage-invalid-error";

import { AppError } from "@/shared/errors/AppError";
import { Fuel, UpdateFuelProps } from "../../dtos/fuel-dto";

interface UpdateFuelRequest {
  fuelId: string;
  businessId: string;
  fuelData: UpdateFuelProps;
}

@injectable()
class UpdateFuelUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("VehicleRepository")
    private vehicle: IVehicleRepository,
    @inject("DriverRepository")
    private driver: IDriverRepository,
    @inject("FuelTypeRepository")
    private fuelType: IFuelTypeRepository,
    @inject("BranchRepository")
    private branch: IBranchRepository,
    @inject("FuelRepository")
    private fuel: IFuelRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute(
    { fuelId, businessId, fuelData }: UpdateFuelRequest,
    userId: string,
  ): Promise<Fuel> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    // Validate business exists
    const findBusiness = await this.business.findBusinessById(businessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    // Validate fuel exists and belongs to business
    const findFuel = await this.fuel.getFuelByIdAndBusiness({
      businessId,
      fuelId,
    });

    if (!findFuel) {
      throw new FuelNotFoundError();
    }

    if (findFuel.businessId !== businessId) {
      throw new FuelNotBelongBusinessError();
    }

    // If updating vehicle, validate it exists and belongs to business
    if (fuelData.vehicleId) {
      const findVehicle = await this.vehicle.findVehicleById(
        fuelData.vehicleId,
      );

      if (!findVehicle) {
        throw new VehicleNotFoundError();
      }

      if (findVehicle.businessId !== businessId) {
        throw new VehicleNotBelongBusinessError();
      }

      // Validate mileage (cannot be less than current vehicle mileage)
      if (
        fuelData.current_mileage &&
        fuelData.current_mileage < findVehicle.current_mileage
      ) {
        throw new VehicleMileageInvalidError();
      }
    }

    // If updating driver, validate it exists and belongs to business
    if (fuelData.driverId) {
      const findDriver = await this.driver.findDriverById(fuelData.driverId);

      if (!findDriver) {
        throw new DriverNotFoundError();
      }

      if (findDriver.businessId !== businessId) {
        throw new DriverNotBelongBusinessError();
      }
    }

    // If updating fuel type, validate it exists and belongs to business
    if (fuelData.fuelTypeId) {
      const findFuelType = await this.fuelType.findFuelTypeById(
        fuelData.fuelTypeId,
      );

      if (!findFuelType) {
        throw new FuelTypeNotFoundError();
      }

      if (findFuelType.businessId !== businessId) {
        throw new FuelTypeNotBelongBusinessError();
      }
    }

    // If updating branch, validate it exists and belongs to business
    if (fuelData.branchId) {
      const findBranch = await this.branch.findBranchById(fuelData.branchId);

      if (!findBranch) {
        throw new BranchNotFoundError();
      }

      if (findBranch.businessId !== businessId) {
        throw new BranchNotBelongBusinessError();
      }
    }

    try {
      // Update fuel record
      const updatedFuel = await this.fuel.updateFuel({
        fuelId,
        fuelData,
      });

      // If mileage is updated, update vehicle mileage as well
      if (fuelData.current_mileage) {
        const vehicleId = fuelData.vehicleId || findFuel.vehicleId;
        await this.vehicle.updateVehicle({
          vehicleId,
          vehicleData: {
            current_mileage: fuelData.current_mileage,
          },
        });
      }

      // Process activity asynchronously without blocking the main flow
      const vehicleForNotification = fuelData.vehicleId
        ? await this.vehicle.findVehicleById(fuelData.vehicleId)
        : await this.vehicle.findVehicleById(findFuel.vehicleId);

      this.notificationService.createActivityIfEnabled({
        type: "fuel",
        action: "update",
        entityId: fuelId,
        description: `Abastecimento atualizado para o veículo ${vehicleForNotification?.license_plate} - ${vehicleForNotification?.description}`,
        status: "Atualizado",
        performedBy: userId,
        businessId: businessId,
      });

      return updatedFuel;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar atualizar o abastecimento! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { UpdateFuelUseCase };
