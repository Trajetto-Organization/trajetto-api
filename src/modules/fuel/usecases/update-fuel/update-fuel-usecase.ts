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
import {
  assertRefuelingNotInTheFuture,
  businessTimeZone,
  changedLinks,
} from "../fuel-rules";
import { recordDate } from "@/shared/vehicle/odometer-timeline";
import { pickedDateFromInput } from "@/shared/vehicle/record-dates";

import { AIAnalysisService } from "@/shared/ai/ai-analysis-service";
import { logger } from "@/shared/logging/logger";

const log = logger.child({ component: "fuel" });

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

    // A replacement photo the client uploaded straight to storage. Absent when
    // the edit does not touch the photo.
    presignedPhoto?: { key: string },
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

    // Scoped by company: another company's refueling is not found, the same
    // answer as a missing one (404 FUEL_NOT_FOUND).
    const findFuel = await this.fuel.getFuelByIdAndBusiness({
      businessId,
      fuelId,
    });

    if (!findFuel) {
      throw new FuelNotFoundError();
    }

    // Security: Drivers cannot update fuel records
    if (findUser.role === "BUSINESS_USER" && findUser.driverId) {
      throw new FuelDriverCannotUpdateFuelError();
    }

    assertRefuelingNotInTheFuture(fuelData.refueling_date, findBusiness);

    // A bare day is stored as the instant it starts in the company's zone.
    if (fuelData.refueling_date !== undefined) {
      fuelData.refueling_date = pickedDateFromInput(
        fuelData.refueling_date,
        businessTimeZone(findBusiness),
      );
    }

    // What the edit re-points. A link that stays where it was is history,
    // and history is not re-validated against today's state (FLEET-FUEL-1).
    const links = changedLinks(findFuel, fuelData);

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

    // Only a vehicle the record MOVES to has to be fuelable today: last
    // month's fueling of a truck that is now inactive or blocked still gets
    // its price corrected.
    if (
      links.vehicle &&
      findVehicle.status !== "ACTIVE" &&
      findVehicle.status !== "IN_ROUTE"
    ) {
      throw new FuelVehicleInvalidStatusForFuelError();
    }

    const effectiveMileage =
      fuelData.current_mileage ?? findFuel.current_mileage;

    const effectiveDate = recordDate(
      fuelData.refueling_date ?? findFuel.refueling_date,
    );

    const vehicleChanged = vehicleId !== findFuel.vehicleId;
    const mileageChanged = effectiveMileage !== findFuel.current_mileage;

    // The web resends the stored instant when the date is left alone; only a
    // different instant moves the reading on the timeline.
    const dateChanged =
      effectiveDate.getTime() !== new Date(findFuel.refueling_date).getTime();

    // A changed reading, date or vehicle is decided inside the repository's
    // transaction by placeReading (fuel-rules.ts): at its date, itself left
    // out. The check that stood here compared an old record with today's
    // odometer, so no past refueling could have its km corrected, and a
    // date-only edit was never checked at all: the refueling of 45.500 km
    // moved before the one of 40.000 was accepted.

    // If updating driver, validate it exists and belongs to business
    if (fuelData.driverId) {
      const findDriver = await this.driver.findDriverById(fuelData.driverId);

      if (!findDriver) {
        throw new DriverNotFoundError();
      }

      if (findDriver.businessId !== businessId) {
        throw new DriverNotBelongBusinessError();
      }

      // Same rule as the vehicle: the driver who fueled keeps being the one
      // who fueled after leaving the company.
      if (links.driver && findDriver.status !== "ACTIVE") {
        throw new AppError(
          "O motorista selecionado está inativo.",
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

      if (links.branch && findBranch.is_active === false) {
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

      // If there's a new photo, record it and delete the old one
      if (presignedPhoto) {
        const [resolved] = await this.uploadService.resolvePresignedUploads(
          [presignedPhoto],
          "odometerPhotos",
          businessId,
        );

        uploadedPhotoPath = resolved.path;
        finalFuelData.odometer_photo = resolved.path;
      }

      const targetVehicleId = fuelData.vehicleId || findFuel.vehicleId;

      const updatedFuel = await this.fuel.updateFuelAndMileage(
        { fuelId, fuelData: finalFuelData },
        mileageChanged || vehicleChanged || dateChanged
          ? {
              businessId,
              vehicleId: targetVehicleId,
              currentMileage: effectiveMileage,
              at: effectiveDate,
              timeZone: businessTimeZone(findBusiness),
              fuelId,
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
        // Was tied to the multipart file, which the presigned path never set —
        // so replacing only the photo never re-triggered verification, and the
        // record kept an AI result describing the previous image.
        const photoChanged = presignedPhoto !== undefined;
        const mileageChanged =
          fuelData.current_mileage &&
          fuelData.current_mileage !== findFuel.current_mileage;

        if (photoChanged || mileageChanged) {
          const photoPath =
            finalFuelData.odometer_photo || findFuel.odometer_photo;
          const mileage = fuelData.current_mileage || findFuel.current_mileage;

          if (photoPath) {
            AIAnalysisService.getInstance()
              .requestAnalysis({
                type: "FUEL_ODOMETER",
                recordId: fuelId,
                businessId,
                requestedById: userId,
                input: {
                  odometerPhotoPath: photoPath,
                  reportedMileage: mileage,
                },
              })
              .catch((err) =>
                log.error(
                  { err, fuelId, businessId },
                  "AI fuel re-verification could not be requested",
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

      // Refusals the transaction decides (the record or the vehicle gone
      // meanwhile included) keep their own answer instead of a 500.
      if (
        error instanceof VehicleMileageInvalidError ||
        error instanceof FuelNotFoundError ||
        error instanceof VehicleNotFoundError ||
        error instanceof AppError
      ) {
        throw error;
      }

      log.error({ err: error, fuelId }, "fuel record could not be updated");
      throw new AppError(
        "Houve um erro ao tentar atualizar o abastecimento! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { UpdateFuelUseCase };
