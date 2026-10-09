import { inject, injectable } from "tsyringe";
import { IVehicleChecklistRepository } from "@/modules/vehicle-checklist/repositories/IVehicle-checklist-repository";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";

import { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";
import { IBranchRepository } from "@/modules/branch/repositories/IBranch-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { NotificationService } from "@/shared/services/notification-service";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";
import { DriverNotFoundError } from "@/modules/driver/usecases/errors/driver-not-found-error";

import { BranchNotFoundError } from "@/modules/branch/usecases/errors/branch-not-found-error";

import { VehicleNotBelongBusinessError } from "@/modules/vehicle/usecases/errors/vehicle-not-belong-business-error";
import { DriverNotBelongBusinessError } from "@/modules/driver/usecases/errors/driver-not-belong-business-error";

import { BranchNotBelongBusinessError } from "@/modules/branch/usecases/errors/branch-not-belong-business-error";
import { VehicleMileageInvalidError } from "@/modules/vehicle/usecases/errors/vehicle-mileage-invalid-error";

import { VehicleChecklistDriverCannotUpdateChecklistError } from "../errors/vehicle-checklist-driver-cannot-update-checklist-error";
import { VehicleChecklistBusinessNotFoundError } from "../errors/vehicle-checklist-business-not-found-error";

import { AppError } from "@/shared/errors/AppError";
import {
  VehicleChecklist,
  UpdateVehicleChecklistProps,
} from "../../dtos/vehicle-checklist-dto";

import { UploadService } from "@/shared/services/upload-service";

import { PhotoValidationService } from "@/shared/services/photo-validation-service";
import { VehicleChecklistRequiredPhotosMissingError } from "../errors/vehicle-checklist-required-photos-missing-error";

import { AIAnalysisService } from "@/shared/ai/ai-analysis-service";
import { refreshChecklistVerdict } from "@/shared/ai/ai-record-store";
import { uploadConfig } from "@/config/upload";
import { logger } from "@/shared/logging/logger";
import { recordDate } from "@/shared/vehicle/odometer-timeline";
import { pickedDateFromInput } from "@/shared/vehicle/record-dates";

import {
  assertChecklistNotInTheFuture,
  changedChecklistLinks,
  checklistDateMoved,
  withChecklistDate,
} from "../checklist-rules";

const log = logger.child({ component: "vehicle-checklist" });

/** Whether the checklist holds per-field AI outcomes to compare again. */
function hasAiVerdictDetails(details: unknown): boolean {
  return (
    typeof details === "object" &&
    details !== null &&
    !Array.isArray(details) &&
    Object.keys(details).length > 0
  );
}

@injectable()
class UpdateVehicleChecklistUseCase {
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
    @inject("NotificationService")
    private notificationService: NotificationService,
    @inject("UploadService")
    private uploadService: UploadService,
  ) {}

  async execute(
    checklistData: UpdateVehicleChecklistProps,
    userId: string,
    checklistId: string,
    businessId: string,
    photosByField?: { [key: string]: any },
    photosToRemove?: string[],

    // Photos the client already put in storage, as keys. Grouped by field in
    // `photosByField` as well, which is what the required-photo validation
    // above reads.
    presignedPhotos?: { key: string; fieldName?: string }[],
  ): Promise<VehicleChecklist> {
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

    // Validate checklist exists and belongs to business
    const findChecklist =
      await this.vehicleChecklist.getVehicleChecklistByIdAndBusiness({
        businessId,
        checklistId,
      });

    if (!findChecklist) {
      throw new VehicleChecklistBusinessNotFoundError();
    }

    // Validate photo requirements for any field changes
    // This prevents bypassing mandatory photo requirements by considering existing photos
    if (photosByField !== undefined && photosToRemove !== undefined) {
      const photoValidation =
        PhotoValidationService.validateRequiredPhotosForUpdate(
          checklistData,
          photosByField,
          findChecklist.photos || [],
          photosToRemove,
        );

      if (!photoValidation.isValid) {
        throw new VehicleChecklistRequiredPhotosMissingError(
          photoValidation.missingPhotos,
          photoValidation.errors,
          Object.keys(checklistData),
          Object.keys(photosByField),
          findChecklist.photos || [],
          photosToRemove,
        );
      }
    }

    // Determine the vehicle to use (updated or existing)
    const vehicleId = checklistData.vehicleId || findChecklist.vehicleId;
    const findVehicle = await this.vehicle.findVehicleById(vehicleId);

    if (!findVehicle) {
      throw new VehicleNotFoundError();
    }

    // If updating vehicle, validate it belongs to business
    if (checklistData.vehicleId && findVehicle.businessId !== businessId) {
      throw new VehicleNotBelongBusinessError();
    }

    // The route already refuses driver tokens (allowDriver: false); kept as
    // defence in depth for any other caller of this use case.
    if (findUser.role === "BUSINESS_USER" && findUser.driverId) {
      throw new VehicleChecklistDriverCannotUpdateChecklistError();
    }

    const effectiveMileage =
      checklistData.current_mileage ?? findChecklist.current_mileage;
    const vehicleChanged = vehicleId !== findChecklist.vehicleId;
    const mileageChanged = effectiveMileage !== findChecklist.current_mileage;
    // A resent day is compared as the instant it is stored at.
    const dateChanged = checklistDateMoved(
      findChecklist.checklist_date,
      pickedDateFromInput(checklistData.checklist_date, findBusiness.timezone),
    );

    // Only a date the edit moves is held to today: the web resends the
    // stored date on every edit, and a row already dated ahead (the
    // date-only tomorrows the old rule let through) could not get a note
    // fixed without also being moved.
    if (dateChanged) {
      assertChecklistNotInTheFuture(checklistData.checklist_date, findBusiness);
    }

    // A changed reading, vehicle or date is decided inside the repository's
    // transaction, by the checklist's date first (placeReading, the fueling
    // edit's rule, over shared/vehicle/odometer-timeline): between the
    // readings around it, itself left out, or above them as the newest, when
    // the odometer follows. The old check compared an old record with today's
    // odometer, so no past checklist could have its km corrected, and one
    // raised above the odometer jumped it past every later record.

    // Only a link the edit re-points is held to today's state (FLEET-FUEL-1):
    // the web resent every link, and last month's checklist of a driver who
    // left, or at a branch since closed, could not have a note corrected.
    const links = changedChecklistLinks(findChecklist, checklistData);

    // If updating driver, validate it exists and belongs to business
    if (checklistData.driverId) {
      const findDriver = await this.driver.findDriverById(
        checklistData.driverId,
      );

      if (!findDriver) {
        throw new DriverNotFoundError();
      }

      if (findDriver.businessId !== businessId) {
        throw new DriverNotBelongBusinessError();
      }

      if (links.driver && findDriver.status !== "ACTIVE") {
        throw new AppError(
          "O motorista selecionado está inativo.",
          422,
          "DRIVER_INACTIVE",
        );
      }
    }

    // If updating branch, validate it exists and belongs to business
    if (checklistData.branchId) {
      const findBranch = await this.branch.findBranchById(
        checklistData.branchId,
      );

      if (!findBranch) {
        throw new BranchNotFoundError();
      }

      if (findBranch.businessId !== businessId) {
        throw new BranchNotBelongBusinessError();
      }

      if (links.branch && findBranch.is_active === false) {
        throw new AppError(
          "Não é permitido mover o checklist para uma filial inativa.",
          409,
          "BRANCH_INACTIVE",
        );
      }
    }

    const newPhotoPaths: string[] = [];
    let oldPhotoPathsToDelete: string[] = [];
    let databaseCommitted = false;

    try {
      // Upload checklist photos if provided
      const newPhotoPathsByField: Record<string, string[]> = {};

      if (presignedPhotos && presignedPhotos.length > 0) {
        // Already in the bucket. Only the ownership and existence checks are
        // left before these keys become rows.
        const resolved = await this.uploadService.resolvePresignedUploads(
          presignedPhotos,
          "checklistPhotos",
          businessId,
          uploadConfig.maxChecklistTotalBytes,
        );

        for (const photo of resolved) {
          newPhotoPaths.push(photo.path);

          if (photo.fieldName) {
            newPhotoPathsByField[photo.fieldName] ??= [];
            newPhotoPathsByField[photo.fieldName].push(photo.path);
          }
        }
      }

      // Merge existing photos with new photos, considering photos to remove
      let finalPhotos: string[] = [];

      // Start with existing photos
      if (findChecklist.photos && findChecklist.photos.length > 0) {
        finalPhotos = [...findChecklist.photos];
      }

      // Remove photos that should be deleted
      if (photosToRemove && photosToRemove.length > 0) {
        // Only what THIS checklist actually holds. The list comes from the
        // client, and every entry was deleted from the bucket after the
        // commit — so any key the caller could name went: another checklist's
        // photos, a delivery's signed proof PDF, another company's files.
        const ownedPaths = new Set<string>(findChecklist.photos ?? []);

        const byField = findChecklist.photos_by_field;

        if (byField && typeof byField === "object" && !Array.isArray(byField)) {
          for (const paths of Object.values(
            byField as Record<string, unknown>,
          )) {
            if (!Array.isArray(paths)) continue;

            for (const path of paths) {
              if (typeof path === "string") ownedPaths.add(path);
            }
          }
        }

        // Convert URLs to relative paths for comparison and deletion
        oldPhotoPathsToDelete = photosToRemove
          .map((photoUrl) => this.uploadService.extractFilePath(photoUrl))
          .filter((path) => ownedPaths.has(path));

        // Remove from array using relative paths
        finalPhotos = finalPhotos.filter(
          (photo) => !oldPhotoPathsToDelete.includes(photo),
        );
      }

      // Add new photos
      if (newPhotoPaths.length > 0) {
        finalPhotos = [...finalPhotos, ...newPhotoPaths];
      }

      const existingPhotosByField =
        findChecklist.photos_by_field &&
        typeof findChecklist.photos_by_field === "object" &&
        !Array.isArray(findChecklist.photos_by_field)
          ? (findChecklist.photos_by_field as Record<string, unknown>)
          : {};
      const finalPhotosByField = Object.fromEntries(
        Object.entries(existingPhotosByField).map(([fieldName, paths]) => [
          fieldName,
          Array.isArray(paths)
            ? paths.filter(
                (photoPath): photoPath is string =>
                  typeof photoPath === "string" &&
                  !oldPhotoPathsToDelete.includes(photoPath),
              )
            : [],
        ]),
      ) as Record<string, string[]>;

      for (const [fieldName, paths] of Object.entries(newPhotoPathsByField)) {
        finalPhotosByField[fieldName] = [
          ...(finalPhotosByField[fieldName] ?? []),
          ...paths,
        ];
      }

      // Add photo paths to checklist data only if there are photos or if photos were modified
      const photosChanged =
        newPhotoPaths.length > 0 ||
        Boolean(photosToRemove && photosToRemove.length > 0);
      const checklistDataWithPhotos = withChecklistDate(
        photosChanged
          ? {
              ...checklistData,
              photos: finalPhotos,
              photos_by_field: finalPhotosByField,
            }
          : checklistData,
        findBusiness.timezone,
      );
      const targetVehicleId =
        checklistData.vehicleId ?? findChecklist.vehicleId;

      const updatedChecklist =
        await this.vehicleChecklist.updateVehicleChecklistAndMileage(
          {
            checklistData: checklistDataWithPhotos,
            checklistId,
          },
          mileageChanged || vehicleChanged || dateChanged
            ? {
                businessId,
                vehicleId: targetVehicleId,
                currentMileage: effectiveMileage,
                at: recordDate(
                  checklistDataWithPhotos.checklist_date ??
                    findChecklist.checklist_date,
                ),
                checklistId,
                timeZone: findBusiness.timezone,
                readingChanged: mileageChanged || vehicleChanged,
              }
            : undefined,
        );
      databaseCommitted = true;

      // Remove superseded objects only after the transaction succeeds.
      await Promise.allSettled(
        oldPhotoPathsToDelete.map((photoPath) =>
          this.uploadService.deleteFile(photoPath),
        ),
      );

      // Get vehicle information for activity description
      const findVehicle = await this.vehicle.findVehicleById(
        updatedChecklist.vehicleId,
      );

      // Process activity asynchronously without blocking the main flow
      this.notificationService.createActivityIfEnabled({
        type: "Checklist Veicular",
        action: "update",
        entityId: updatedChecklist.id,
        description: findVehicle
          ? `Checklist veicular atualizado para o veículo ${findVehicle.license_plate} - ${findVehicle.description}`
          : `Checklist veicular atualizado`,
        status: "Atualizado",
        performedBy: userId,
        businessId: businessId,
      });

      // An edit of an informed value (no new photo) is compared again with
      // the readings already paid for (AI-2): a manager who corrected a
      // condition after the AI flagged it kept "Não confere", and the
      // "Verificar com IA" button is hidden over issues_found. No provider
      // call, no quota; it writes only when an outcome changed. Awaited so the
      // next read shows it; a failure is logged, the edit already committed.
      if (hasAiVerdictDetails(findChecklist.ai_verification_details)) {
        try {
          await refreshChecklistVerdict(updatedChecklist.id);
        } catch (err) {
          log.error(
            { err, checklistId: updatedChecklist.id, businessId },
            "AI checklist verdict could not be compared again",
          );
        }
      }

      // Re-verify AI when new photos were added (fire-and-forget)
      // Skip if business has AI disabled (limit === 0)
      if (
        (findBusiness.ai_analysis_limit ?? 0) > 0 &&
        Object.keys(newPhotoPathsByField).length > 0
      ) {
        AIAnalysisService.getInstance()
          .requestAnalysis({
            type: "CHECKLIST",
            recordId: updatedChecklist.id,
            businessId,
            requestedById: userId,
            input: {
              photosByField: newPhotoPathsByField,
              checklistData: checklistData as Record<string, unknown>,
            },
          })
          .catch((err) =>
            log.error(
              { err, checklistId: updatedChecklist.id, businessId },
              "AI checklist re-verification could not be requested",
            ),
          );
      }

      return updatedChecklist;
    } catch (error) {
      if (!databaseCommitted) {
        await Promise.allSettled(
          newPhotoPaths.map((photoPath) =>
            this.uploadService.deleteFile(photoPath),
          ),
        );
      }

      // The transaction re-reads the checklist and the vehicle: one deleted
      // meanwhile is a 404/400 like before the edit started, not a 500.
      if (
        error instanceof VehicleMileageInvalidError ||
        error instanceof VehicleChecklistBusinessNotFoundError ||
        error instanceof VehicleNotFoundError ||
        error instanceof AppError
      ) {
        throw error;
      }

      log.error(
        { err: error, checklistId },
        "vehicle checklist could not be updated",
      );
      throw new AppError(
        "Houve um erro ao tentar atualizar o checklist veicular! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { UpdateVehicleChecklistUseCase };
