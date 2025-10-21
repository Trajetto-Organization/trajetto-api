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
import { VehicleInvalidStatusForFuelError } from "../errors/vehicle-invalid-status-for-fuel-error";

import { DriverCannotUpdateFuelError } from "../errors/driver-cannot-update-fuel-error";

import { AppError } from "@/shared/errors/AppError";
import { Fuel, UpdateFuelProps } from "../../dtos/fuel-dto";

import { UploadService } from "@/shared/services/upload-service";
import { MultipartFile } from "@fastify/multipart";

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
    @inject("UploadService")
    private uploadService: UploadService,
  ) {}

  async execute(
    { fuelId, businessId, fuelData }: UpdateFuelRequest,
    userId: string,
    odometerPhotoFile?: MultipartFile,
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

    // Determine the vehicle to use (updated or existing)
    const vehicleId = fuelData.vehicleId || findFuel.vehicleId;
    const findVehicle = await this.vehicle.findVehicleById(vehicleId);

    if (!findVehicle) {
      throw new VehicleNotFoundError();
    }

    // If updating vehicle, validate it belongs to business
    if (fuelData.vehicleId && findVehicle.businessId !== businessId) {
      throw new VehicleNotBelongBusinessError();
    }

    // Security: Drivers cannot update fuel records
    if (findUser.role === "BUSINESS_USER" && findUser.driverId) {
      throw new DriverCannotUpdateFuelError();
    }

    // Validate vehicle status (only ACTIVE or IN_ROUTE vehicles can be fueled)
    if (findVehicle.status !== "ACTIVE" && findVehicle.status !== "IN_ROUTE") {
      throw new VehicleInvalidStatusForFuelError();
    }

    // Validate mileage only if it was changed
    // If mileage is being updated and is different from the original fuel mileage
    if (
      fuelData.current_mileage &&
      fuelData.current_mileage !== findFuel.current_mileage
    ) {
      // New mileage must be strictly greater than current vehicle mileage
      if (fuelData.current_mileage <= findVehicle.current_mileage) {
        throw new VehicleMileageInvalidError();
      }
    }

    // Auto-populate branchId and fuelTypeId for driver users
    if (findUser.driverId) {
      const driverUser = await this.driver.findDriverById(findUser.driverId);
      if (driverUser) {
        // Force fuelTypeId to match vehicle's fuel type (drivers cannot change it)
        fuelData.fuelTypeId = findVehicle.fuelTypeId;

        // Force branchId - drivers cannot select branch manually
        // Priority: Vehicle.branchId → Driver.branchId
        fuelData.branchId =
          findVehicle.branchId || driverUser.branchId || undefined;
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
      let finalFuelData = { ...fuelData };

      // If there's a new photo, upload it and delete the old one
      if (odometerPhotoFile) {
        // Upload new photo
        const buffer = await odometerPhotoFile.toBuffer();
        const uploadResult = await this.uploadService.uploadFile({
          buffer,
          filename: odometerPhotoFile.filename || "odometer-photo",
          mimetype: odometerPhotoFile.mimetype,
          uploadType: "odometerPhotos",
        });

        // Delete old photo if it exists
        if (findFuel.odometer_photo) {
          await this.uploadService.deleteFile(findFuel.odometer_photo);
        }

        // Add new photo path to fuel data
        finalFuelData.odometer_photo = uploadResult.path;
      }

      // Update fuel record
      const updatedFuel = await this.fuel.updateFuel({
        fuelId,
        fuelData: finalFuelData,
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
        type: "Abastecimento",
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
