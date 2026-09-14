import { inject, injectable } from "tsyringe";
import { IVehicleChecklistRepository } from "@/modules/vehicle-checklist/repositories/IVehicle-checklist-repository";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";

import { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";
import { IBranchRepository } from "@/modules/branch/repositories/IBranch-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { OutboxService } from "@/shared/notifications/outbox-service";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";
import { DriverNotFoundError } from "@/modules/driver/usecases/errors/driver-not-found-error";

import { BranchNotFoundError } from "@/modules/branch/usecases/errors/branch-not-found-error";

import { VehicleNotBelongBusinessError } from "@/modules/vehicle/usecases/errors/vehicle-not-belong-business-error";
import { DriverNotBelongBusinessError } from "@/modules/driver/usecases/errors/driver-not-belong-business-error";

import { BranchNotBelongBusinessError } from "@/modules/branch/usecases/errors/branch-not-belong-business-error";
import { VehicleMileageInvalidError } from "@/modules/vehicle/usecases/errors/vehicle-mileage-invalid-error";

import { VehicleNotAssignedToDriverError } from "@/modules/vehicle/usecases/errors/vehicle-not-assigned-to-driver-error";
import { AppError } from "@/shared/errors/AppError";

import {
  VehicleChecklist,
  CreateVehicleChecklistProps,
} from "../../dtos/vehicle-checklist-dto";

import { UploadService } from "@/shared/services/upload-service";

import { AIAnalysisService } from "@/shared/ai/ai-analysis-service";
import { uploadConfig } from "@/config/upload";

@injectable()
class CreateVehicleChecklistUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("VehicleRepository")
    private vehicle: IVehicleRepository,
    @inject("DriverRepository")
    private driver: IDriverRepository,
    @inject("BranchRepository")
    private branch: IBranchRepository,
    @inject("VehicleChecklistRepository")
    private vehicleChecklist: IVehicleChecklistRepository,
    @inject("OutboxService")
    private outbox: OutboxService,
    @inject("UploadService")
    private uploadService: UploadService,
  ) {}

  async execute(
    checklistData: CreateVehicleChecklistProps,
    userId: string,

    // Photos the client already uploaded straight to storage. Only their keys
    // reach this API — the bytes went from the device to the bucket.
    presignedPhotos?: { key: string; fieldName?: string }[],
  ): Promise<VehicleChecklist> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    // Validate business exists
    const findBusiness = await this.business.findBusinessById(
      checklistData.businessId,
    );

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    if (
      findUser.role !== "MASTER" &&
      findUser.businessId !== checklistData.businessId
    ) {
      throw new AppError(
        "Você não tem autorização para registrar dados nesta empresa.",
        403,
        "TENANT_ACCESS_DENIED",
      );
    }

    if (checklistData.client_submission_id) {
      const existingChecklist = await this.vehicleChecklist.findBySubmissionId(
        checklistData.businessId,
        checklistData.client_submission_id,
      );

      if (existingChecklist) return existingChecklist;
    }

    // Validate vehicle exists and belongs to business
    const findVehicle = await this.vehicle.findVehicleById(
      checklistData.vehicleId,
    );

    if (!findVehicle) {
      throw new VehicleNotFoundError();
    }

    if (findVehicle.businessId !== checklistData.businessId) {
      throw new VehicleNotBelongBusinessError();
    }

    // Security: If user is a driver, verify vehicle belongs to them
    if (findUser.role === "BUSINESS_USER" && findUser.driverId) {
      if (findVehicle.driverId !== findUser.driverId) {
        throw new VehicleNotAssignedToDriverError();
      }
    }

    // Auto-populate branchId and driverId for driver users
    if (findUser.driverId) {
      const driverUser = await this.driver.findDriverById(findUser.driverId);
      if (driverUser) {
        checklistData.driverId = findUser.driverId;

        // Force branchId - drivers cannot select branch manually
        // Priority: Vehicle.branchId → Driver.branchId
        checklistData.branchId =
          findVehicle.branchId || driverUser.branchId || undefined;
      }
    }

    // Validate mileage (cannot be less than current vehicle mileage)
    if (checklistData.current_mileage <= findVehicle.current_mileage) {
      throw new VehicleMileageInvalidError();
    }

    // Validate driver exists and belongs to business (if driverId is provided)
    if (checklistData.driverId) {
      const findDriver = await this.driver.findDriverById(
        checklistData.driverId,
      );

      if (!findDriver) {
        throw new DriverNotFoundError();
      }

      if (findDriver.businessId !== checklistData.businessId) {
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

    // Validate branch exists and belongs to business (if branchId is provided)
    if (checklistData.branchId) {
      const findBranch = await this.branch.findBranchById(
        checklistData.branchId,
      );

      if (!findBranch) {
        throw new BranchNotFoundError();
      }

      if (findBranch.businessId !== checklistData.businessId) {
        throw new BranchNotBelongBusinessError();
      }

      if (findBranch.is_active === false) {
        throw new AppError(
          "Não é permitido registrar checklist em uma filial inativa.",
          409,
          "BRANCH_INACTIVE",
        );
      }
    }

    if (!checklistData.branchId) {
      throw new AppError(
        "A filial é obrigatória para registrar o checklist.",
        400,
        "BRANCH_REQUIRED",
      );
    }

    if (!checklistData.driverId) {
      throw new AppError(
        "O motorista é obrigatório para registrar o checklist.",
        400,
        "DRIVER_REQUIRED",
      );
    }

    // Photos this request attached, kept so they can be removed if the record
    // never gets written. The client uploaded them, not this API, but an object
    // with no row pointing at it is still just cost sitting in the bucket.
    const attachedPhotoPaths: string[] = [];
    let databaseCommitted = false;

    try {
      const photoPaths: string[] = [];
      const photoPathsByField: Record<string, string[]> = {};

      if (presignedPhotos && presignedPhotos.length > 0) {
        // Nothing to upload — the bytes are already in the bucket. All that is
        // left is proving each key belongs to this business and really exists
        // before it becomes a database row.
        const resolved = await this.uploadService.resolvePresignedUploads(
          presignedPhotos,
          "checklistPhotos",
          checklistData.businessId,
          uploadConfig.maxChecklistTotalBytes,
        );

        for (const photo of resolved) {
          photoPaths.push(photo.path);
          attachedPhotoPaths.push(photo.path);

          if (photo.fieldName) {
            photoPathsByField[photo.fieldName] ??= [];
            photoPathsByField[photo.fieldName].push(photo.path);
          }
        }
      }

      // Add photo paths to checklist data
      const checklistDataWithPhotos = {
        ...checklistData,
        photos: photoPaths,
        photos_by_field:
          Object.keys(photoPathsByField).length > 0
            ? photoPathsByField
            : undefined,
      };

      // Record creation, mileage advancement and the outbox event are
      // committed atomically; the pipeline turns the event into the activity
      // trail entry after the commit.
      const { checklist: checklistCreated, created } =
        await this.vehicleChecklist.createVehicleChecklistWithMileage(
          checklistDataWithPhotos,
          (tx, checklist) =>
            this.outbox.publish(tx, {
              topic: "vehicle-checklist.created",
              aggregateType: "vehicle-checklist",
              aggregateId: checklist.id,
              businessId: checklistData.businessId,
              actorId: userId,
              eventKey: `vehicle-checklist.created:${checklist.id}`,
              payload: {
                checklistId: checklist.id,
                businessId: checklistData.businessId,
                vehiclePlate: findVehicle.license_plate,
                vehicleDescription: findVehicle.description,
                origin: checklistData.created_from ?? "WEB_DASHBOARD",
              },
            }),
        );

      if (!created) {
        // An idempotent retry: the original checklist keeps its own photos, so
        // the ones this attempt uploaded belong to nothing.
        await Promise.allSettled(
          attachedPhotoPaths.map((photoPath) =>
            this.uploadService.deleteFile(photoPath),
          ),
        );

        return checklistCreated;
      }

      databaseCommitted = true;

      // Request AI verification for checklist photos (fire-and-forget)
      // Skip if business has AI disabled (limit === 0)
      if (
        (findBusiness.ai_analysis_limit ?? 0) > 0 &&
        Object.keys(photoPathsByField).length > 0
      ) {
        AIAnalysisService.getInstance()
          .requestAnalysis({
            type: "CHECKLIST",
            recordId: checklistCreated.id,
            businessId: checklistData.businessId,
            requestedById: userId,
            input: {
              photosByField: photoPathsByField,
              checklistData: checklistData as unknown as Record<
                string,
                unknown
              >,
            },
          })
          .catch((err) =>
            console.error(
              "[AI] Failed to request checklist verification:",
              err,
            ),
          );
      }

      return checklistCreated;
    } catch (error) {
      if (!databaseCommitted) {
        await Promise.allSettled(
          attachedPhotoPaths.map((photoPath) =>
            this.uploadService.deleteFile(photoPath),
          ),
        );
      }

      if (error instanceof VehicleMileageInvalidError) {
        throw error;
      }

      if (error instanceof AppError) {
        throw error;
      }

      console.error(
        "[CreateVehicleChecklistUseCase] Failed to create checklist:",
        error,
      );
      throw new AppError(
        "Houve um erro ao tentar criar o checklist veicular! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { CreateVehicleChecklistUseCase };
