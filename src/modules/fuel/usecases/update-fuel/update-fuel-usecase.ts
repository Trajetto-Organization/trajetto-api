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
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

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

import { VehicleMileageInvalidError } from "@/modules/vehicle/usecases/errors/vehicle-mileage-invalid-error";

import { FuelVehicleInvalidStatusForFuelError } from "../errors/fuel-vehicle-invalid-status-for-fuel-error";
import { FuelDriverCannotUpdateFuelError } from "../errors/fuel-driver-cannot-update-fuel-error";

import { AppError } from "@/shared/errors/AppError";
import { Fuel, UpdateFuelProps } from "../../dtos/fuel-dto";

import { UploadService } from "@/shared/services/upload-service";
import { MultipartFile } from "@fastify/multipart";

import AIVerificationWorkerService from "@/shared/services/ai-verification-worker-service";
import { readMultipartFile } from "@/shared/utils/read-multipart-file";
import { uploadConfig } from "@/config/upload";

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

    if (findUser.role !== "MASTER" && findUser.businessId !== businessId) {
      throw new AppError(
        "Você não tem autorização para alterar dados nesta empresa.",
        403,
        "TENANT_ACCESS_DENIED",
      );
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
      throw new FuelDriverCannotUpdateFuelError();
    }

    // Validate vehicle status (only ACTIVE or IN_ROUTE vehicles can be fueled)
    if (findVehicle.status !== "ACTIVE" && findVehicle.status !== "IN_ROUTE") {
      throw new FuelVehicleInvalidStatusForFuelError();
    }

    const effectiveMileage =
      fuelData.current_mileage ?? findFuel.current_mileage;
    const vehicleChanged = vehicleId !== findFuel.vehicleId;
    const mileageChanged = effectiveMileage !== findFuel.current_mileage;

    // Moving a record to another vehicle must also advance that vehicle's
    // odometer atomically; otherwise the record and vehicle diverge.
    if (mileageChanged || vehicleChanged) {
      // New mileage must be strictly greater than current vehicle mileage
      if (effectiveMileage <= findVehicle.current_mileage) {
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

      if (findDriver.status !== "ACTIVE") {
        throw new AppError(
          "O motorista selecionado esta inativo.",
          422,
          "DRIVER_INACTIVE",
        );
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

      if (findBranch.is_active === false) {
        throw new AppError(
          "Não é permitido mover o abastecimento para uma filial inativa.",
          409,
          "BRANCH_INACTIVE",
        );
      }
    }

    // 📍 GEOLOCATION LOGIC FOR UPDATE: Process location changes
    // Web dashboard users can add, update, or remove location

    // Check if latitude or longitude were explicitly provided (not undefined)
    const hasLatitude = "latitude" in fuelData;
    const hasLongitude = "longitude" in fuelData;

    if (hasLatitude || hasLongitude) {
      // If both latitude and longitude are provided and not null (adding or updating location)
      if (
        fuelData.latitude !== null &&
        fuelData.longitude !== null &&
        fuelData.latitude &&
        fuelData.longitude
      ) {
        // Set location source as USER_MANUAL for web dashboard updates
        fuelData.location_source = "USER_MANUAL";

        // Add audit fields for web dashboard manual location update
        (fuelData as any).location_edited_by = userId;
        (fuelData as any).location_edited_at = new Date();
      }
      // If either latitude or longitude is null, user is removing the location
      else if (fuelData.latitude === null || fuelData.longitude === null) {
        // User is removing the location - set all location fields to null
        fuelData.latitude = null;
        fuelData.longitude = null;

        fuelData.location_source = "NONE";

        fuelData.latitude_original = null;
        fuelData.longitude_original = null;
      }
    }

    let uploadedPhotoPath: string | null = null;
    let databaseCommitted = false;

    try {
      let finalFuelData = { ...fuelData };

      // If there's a new photo, upload it and delete the old one
      if (odometerPhotoFile) {
        // Upload new photo
        const buffer = await readMultipartFile(odometerPhotoFile, {
          maxBytes: uploadConfig.getSizeLimit("odometerPhotos"),
        });
        const uploadResult = await this.uploadService.uploadFile({
          buffer,
          filename: odometerPhotoFile.filename || "odometer-photo",
          mimetype: odometerPhotoFile.mimetype,
          uploadType: "odometerPhotos",
        });
        uploadedPhotoPath = uploadResult.path;

        // Add new photo path to fuel data
        finalFuelData.odometer_photo = uploadResult.path;
      }

      const targetVehicleId = fuelData.vehicleId || findFuel.vehicleId;

      const updatedFuel = await this.fuel.updateFuelAndMileage(
        { fuelId, fuelData: finalFuelData },
        mileageChanged || vehicleChanged
          ? {
              businessId,
              vehicleId: targetVehicleId,
              currentMileage: effectiveMileage,
            }
          : undefined,
      );
      databaseCommitted = true;

      // Delete the previous object only after the database points to the new
      // one. Deletion is best-effort and can never break the record.
      if (uploadedPhotoPath && findFuel.odometer_photo) {
        await this.uploadService.deleteFile(findFuel.odometer_photo);
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

      // Re-verify AI when photo or mileage changed (fire-and-forget)
      // Skip if business has AI disabled (limit === 0)
      if ((findBusiness.ai_analysis_limit ?? 0) > 0) {
        const photoChanged = odometerPhotoFile !== undefined;
        const mileageChanged =
          fuelData.current_mileage &&
          fuelData.current_mileage !== findFuel.current_mileage;

        if (photoChanged || mileageChanged) {
          const photoPath =
            finalFuelData.odometer_photo || findFuel.odometer_photo;
          const mileage = fuelData.current_mileage || findFuel.current_mileage;

          if (photoPath) {
            AIVerificationWorkerService.getInstance()
              .enqueueVerification({
                type: "fuel_odometer",
                recordId: fuelId,
                businessId,
                userId,
                odometerPhotoPath: photoPath,
                reportedMileage: mileage,
              })
              .catch((err) =>
                console.error(
                  "[AI] Failed to enqueue fuel re-verification:",
                  err,
                ),
              );
          }
        }
      }

      return updatedFuel;
    } catch (error) {
      if (uploadedPhotoPath && !databaseCommitted) {
        await this.uploadService.deleteFile(uploadedPhotoPath);
      }

      if (
        error instanceof VehicleMileageInvalidError ||
        error instanceof AppError
      ) {
        throw error;
      }

      console.error("[UpdateFuelUseCase] Failed to update fuel:", error);
      throw new AppError(
        "Houve um erro ao tentar atualizar o abastecimento! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { UpdateFuelUseCase };
