import { inject, injectable } from "tsyringe";
import { IFuelRepository } from "@/modules/fuel/repositories/IFuel-repository";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";

import { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";
import { IFuelTypeRepository } from "@/modules/fuel-type/repositories/IFuel-type-repository";

import { IBranchRepository } from "@/modules/branch/repositories/IBranch-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { OutboxService } from "@/shared/notifications/outbox-service";

import { SubmissionOwnerMismatchError } from "@/shared/errors/submission-owner-mismatch-error";
import { submissionBelongsToCaller } from "@/shared/security/submission-ownership";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";
import { DriverNotFoundError } from "@/modules/driver/usecases/errors/driver-not-found-error";

import { FuelTypeNotFoundError } from "@/modules/fuel-type/usecases/errors/fuel-type-not-found-error";
import { BranchNotFoundError } from "@/modules/branch/usecases/errors/branch-not-found-error";

import { VehicleNotBelongBusinessError } from "@/modules/vehicle/usecases/errors/vehicle-not-belong-business-error";
import { DriverNotBelongBusinessError } from "@/modules/driver/usecases/errors/driver-not-belong-business-error";

import { FuelTypeNotBelongBusinessError } from "@/modules/fuel-type/usecases/errors/fuel-type-not-belong-business-error";
import { BranchNotBelongBusinessError } from "@/modules/branch/usecases/errors/branch-not-belong-business-error";

import { VehicleMileageInvalidError } from "../../../vehicle/usecases/errors/vehicle-mileage-invalid-error";
import { VehicleNotAssignedToDriverError } from "@/modules/vehicle/usecases/errors/vehicle-not-assigned-to-driver-error";

import { FuelLocationNotProvidedAdjustmentValidationError } from "../errors/fuel-location-not-provided-adjustment-validation-error";
import { FuelRegistrationsMobileLocationRequiredError } from "../errors/fuel-registrations-mobile-location-required-error";

import { FuelVehicleInvalidStatusForFuelError } from "../errors/fuel-vehicle-invalid-status-for-fuel-error";

import { AppError } from "@/shared/errors/AppError";
import { Fuel, CreateFuelProps } from "../../dtos/fuel-dto";

import { UploadService } from "@/shared/services/upload-service";

import { calculateDistance } from "@/shared/utils/geolocation";
import { AIAnalysisService } from "@/shared/ai/ai-analysis-service";

@injectable()
class CreateFuelUseCase {
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
    @inject("OutboxService")
    private outbox: OutboxService,
    @inject("UploadService")
    private uploadService: UploadService,
  ) {}

  async execute(
    fuelData: CreateFuelProps,
    userId: string,

    // The odometer photo, already in storage. Mandatory on create — the
    // controller refuses the request without it.
    presignedPhoto?: { key: string },
  ): Promise<Fuel> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    // Validate business exists
    const findBusiness = await this.business.findBusinessById(
      fuelData.businessId,
    );

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    if (
      findUser.role !== "MASTER" &&
      findUser.businessId !== fuelData.businessId
    ) {
      throw new AppError(
        "Você não tem autorização para registrar dados nesta empresa.",
        403,
        "TENANT_ACCESS_DENIED",
      );
    }

    if (fuelData.client_submission_id) {
      const existingFuel = await this.fuel.findBySubmissionId(
        fuelData.businessId,
        fuelData.client_submission_id,
      );

      if (existingFuel) {
      /**
       * A replay has to belong to the driver replaying it.
       *
       * The key is unique per `(businessId, client_submission_id)`, so the
       * tenant is already safe — but inside one carrier this returned
       * whatever record carried the key, and the driver-ownership check that
       * would have caught it runs further down, after this early return. A
       * guessed identifier therefore read back another driver's submission.
       */
        if (
          !submissionBelongsToCaller(
            findUser.driverId,
            existingFuel.driverId,
          )
        ) {
          throw new SubmissionOwnerMismatchError();
        }

        return existingFuel;
      }
    }

    // Validate vehicle exists and belongs to business
    const findVehicle = await this.vehicle.findVehicleById(fuelData.vehicleId);

    if (!findVehicle) {
      throw new VehicleNotFoundError();
    }

    if (findVehicle.businessId !== fuelData.businessId) {
      throw new VehicleNotBelongBusinessError();
    }

    // Security: If user is a driver, verify vehicle belongs to them
    if (findUser.role === "BUSINESS_USER" && findUser.driverId) {
      if (findVehicle.driverId !== findUser.driverId) {
        throw new VehicleNotAssignedToDriverError();
      }
    }

    // Auto-populate branchId, driverId, and fuelTypeId for driver users
    if (findUser.driverId) {
      const driverUser = await this.driver.findDriverById(findUser.driverId);
      if (driverUser) {
        fuelData.driverId = findUser.driverId;

        // Force fuelTypeId to match vehicle's fuel type (drivers cannot change it)
        fuelData.fuelTypeId = findVehicle.fuelTypeId;

        // Force branchId - drivers cannot select branch manually
        // Priority: Vehicle.branchId → Driver.branchId
        fuelData.branchId =
          findVehicle.branchId || driverUser.branchId || undefined;
      }
    }

    // Validate vehicle status (only ACTIVE or IN_ROUTE vehicles can be fueled)
    if (findVehicle.status !== "ACTIVE" && findVehicle.status !== "IN_ROUTE") {
      throw new FuelVehicleInvalidStatusForFuelError();
    }

    // Validate mileage (must be strictly greater than current vehicle mileage)
    if (fuelData.current_mileage <= findVehicle.current_mileage) {
      throw new VehicleMileageInvalidError();
    }

    // Validate driver exists and belongs to business (if driverId is provided)
    if (fuelData.driverId) {
      const findDriver = await this.driver.findDriverById(fuelData.driverId);

      if (!findDriver) {
        throw new DriverNotFoundError();
      }

      if (findDriver.businessId !== fuelData.businessId) {
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

    // Validate fuel type exists and belongs to business
    const findFuelType = await this.fuelType.findFuelTypeById(
      fuelData.fuelTypeId,
    );
    if (!findFuelType) {
      throw new FuelTypeNotFoundError();
    }

    if (findFuelType.businessId !== fuelData.businessId) {
      throw new FuelTypeNotBelongBusinessError();
    }

    // Validate branch exists and belongs to business (if branchId is provided)
    if (fuelData.branchId) {
      const findBranch = await this.branch.findBranchById(fuelData.branchId);
      if (!findBranch) {
        throw new BranchNotFoundError();
      }

      if (findBranch.businessId !== fuelData.businessId) {
        throw new BranchNotBelongBusinessError();
      }

      if (findBranch.is_active === false) {
        throw new AppError(
          "Não é permitido registrar abastecimento em uma filial inativa.",
          409,
          "BRANCH_INACTIVE",
        );
      }
    }

    if (!fuelData.branchId) {
      throw new AppError(
        "A filial é obrigatória para registrar o abastecimento.",
        400,
        "BRANCH_REQUIRED",
      );
    }

    if (!fuelData.driverId) {
      throw new AppError(
        "O motorista é obrigatório para registrar o abastecimento.",
        400,
        "DRIVER_REQUIRED",
      );
    }

    // 🆕 GEOLOCATION LOGIC: Validate and process location data
    if (fuelData.created_from === "MOBILE_APP") {
      // Mobile: Location is REQUIRED
      if (fuelData.latitude == null || fuelData.longitude == null) {
        throw new FuelRegistrationsMobileLocationRequiredError();
      }

      // 🆕 VALIDATE DISTANCE IF GPS_MANUAL (manual adjustment)
      if (fuelData.location_source === "GPS_MANUAL") {
        // Verifica se temos a localização original
        if (
          fuelData.latitude_original == null ||
          fuelData.longitude_original == null
        ) {
          throw new FuelLocationNotProvidedAdjustmentValidationError();
        }

        // Calcula e valida a distância
        const distance = calculateDistance(
          fuelData.latitude_original,
          fuelData.longitude_original,
          fuelData.latitude,
          fuelData.longitude,
        );

        if (distance > 500) {
          throw new AppError(
            `A localização editada está ${Math.round(distance)}m distante da capturada pelo GPS. Máximo permitido: 500m. Possível inconsistência detectada.`,
            400,
          );
        }

        // Log de auditoria (opcional)
        console.log(
          `[AUDIT] GPS ajustado por ${userId} no fuel: ${Math.round(distance)}m de distância`,
        );
      } else if (!fuelData.location_source) {
        // Se não tem source, é GPS automático
        fuelData.location_source = "GPS_AUTO";

        // Copia localização final para original (não foi editada)
        fuelData.latitude_original = fuelData.latitude;
        fuelData.longitude_original = fuelData.longitude;
      }
    } else if (fuelData.created_from === "WEB_DASHBOARD") {
      // Web: Location is OPTIONAL
      if (fuelData.latitude != null && fuelData.longitude != null) {
        fuelData.location_source = "USER_MANUAL";
      } else {
        fuelData.location_source = "NONE";
      }
    }

    let uploadedPhotoPath: string | null = null;
    let databaseCommitted = false;

    try {
      if (presignedPhoto) {
        // Already in the bucket; only ownership and existence are left to
        // check before the key becomes a row.
        const [resolved] = await this.uploadService.resolvePresignedUploads(
          [presignedPhoto],
          "odometerPhotos",
          fuelData.businessId,
        );

        uploadedPhotoPath = resolved.path;
      }

      // Prepare fuel data with photo and geolocation audit fields
      const fuelDataWithPhoto: any = {
        ...fuelData,
        odometer_photo: uploadedPhotoPath,
      };

      // Add audit fields for web dashboard manual location
      if (
        fuelData.created_from === "WEB_DASHBOARD" &&
        fuelData.latitude != null &&
        fuelData.longitude != null
      ) {
        fuelDataWithPhoto.location_edited_by = userId;
        fuelDataWithPhoto.location_edited_at = new Date();
      }

      // Record creation, the monotonic mileage update and the outbox event
      // are one serializable transaction; the pipeline turns the event into
      // the activity trail entry after the commit. A concurrent retry
      // returns the original record without publishing anything.
      const { fuel: fuelCreated, created } = await this.fuel.createFuelWithMileage(
        fuelDataWithPhoto,
        (tx, fuel) =>
          this.outbox.publish(tx, {
            topic: "fuel.created",
            aggregateType: "fuel",
            aggregateId: fuel.id,
            businessId: fuelData.businessId,
            actorId: userId,
            eventKey: `fuel.created:${fuel.id}`,
            payload: {
              fuelId: fuel.id,
              businessId: fuelData.businessId,
              vehiclePlate: findVehicle.license_plate,
              vehicleDescription: findVehicle.description,
              origin: fuelData.created_from,
            },
          }),
      );

      if (!created) {
        // Only delete what this request put there. On the presigned path the
        // object was uploaded by the client, but it is still orphaned if the
        // row was not created, so it is removed either way.
        if (uploadedPhotoPath) {
          await this.uploadService.deleteFile(uploadedPhotoPath);
        }
        uploadedPhotoPath = null;

        /**
         * The same ownership rule as the early return, for the narrower
         * window the transaction guards.
         *
         * When two drivers submit the same key at the same instant, only one
         * row is created and the other request is handed that row from inside
         * the transaction — past the check further up, which ran against this
         * caller and said nothing about whose record came back.
         */
        if (
          !submissionBelongsToCaller(
            findUser.driverId,
            fuelCreated.driverId,
          )
        ) {
          throw new SubmissionOwnerMismatchError();
        }

        return fuelCreated;
      }
      databaseCommitted = true;

      // Request AI verification for odometer photo (fire-and-forget)
      // Skip if business has AI disabled (limit === 0)
      if ((findBusiness.ai_analysis_limit ?? 0) > 0 && uploadedPhotoPath) {
        AIAnalysisService.getInstance()
          .requestAnalysis({
            type: "FUEL_ODOMETER",
            recordId: fuelCreated.id,
            businessId: fuelData.businessId,
            requestedById: userId,
            input: {
              odometerPhotoPath: uploadedPhotoPath,
              reportedMileage: fuelData.current_mileage,
            },
          })
          .catch((err) =>
            console.error("[AI] Failed to request fuel verification:", err),
          );
      }

      return fuelCreated;
    } catch (error) {
      if (uploadedPhotoPath && !databaseCommitted) {
        await this.uploadService.deleteFile(uploadedPhotoPath);
      }

      if (error instanceof VehicleMileageInvalidError) {
        throw error;
      }

      if (error instanceof AppError) {
        throw error;
      }

      console.error("[CreateFuelUseCase] Failed to create fuel:", error);
      throw new AppError(
        "Houve um erro ao tentar criar o abastecimento! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { CreateFuelUseCase };
