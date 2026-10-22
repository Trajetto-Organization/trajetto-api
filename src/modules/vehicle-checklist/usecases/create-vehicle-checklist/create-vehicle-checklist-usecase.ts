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
import { SubmissionOwnerMismatchError } from "@/shared/errors/submission-owner-mismatch-error";
import { submissionBelongsToCaller } from "@/shared/security/submission-ownership";
import { AppError } from "@/shared/errors/AppError";

import {
  VehicleChecklist,
  CreateVehicleChecklistProps,
} from "../../dtos/vehicle-checklist-dto";

import { UploadService } from "@/shared/services/upload-service";

import { AIAnalysisService } from "@/shared/ai/ai-analysis-service";
import { uploadConfig } from "@/config/upload";
import {
  checklistPhotoKeys,
  isFinalRejection,
  unreferencedKeys,
} from "@/shared/services/presigned-ownership";
import { logger } from "@/shared/logging/logger";
import {
  assertChecklistNotInTheFuture,
  withChecklistDate,
} from "../checklist-rules";
import { timeZoneOfBusiness } from "@/shared/time/business-time-zone";
import { aiProviderConfigured } from "@/shared/ai/ai-provider";
import { acceptDevicePrecheck } from "@/shared/ai-precheck/device-precheck";

const log = logger.child({ component: "vehicle-checklist" });

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

  /**
   * The checklist an earlier attempt already recorded under this key, if any.
   *
   * Called by `execute` and, before any body validation, by the controller:
   * an outbox resend of a record that exists is answered with it even when
   * the frozen body would no longer pass today's schema (see
   * `submissionKeyOf`). The tenant was checked by the route's guards before
   * either caller gets here, and the key is unique per business.
   */
  async findReplay(
    businessId: string,
    submissionId: string,
    callerDriverId: string | null | undefined,
  ): Promise<VehicleChecklist | null> {
    const existingChecklist = await this.vehicleChecklist.findBySubmissionId(
      businessId,
      submissionId,
    );

    if (!existingChecklist) return null;

    /**
     * A replay has to belong to the driver replaying it.
     *
     * The key is unique per `(businessId, client_submission_id)`, so the
     * tenant is already safe — but inside one carrier this returned whatever
     * record carried the key, and the driver-ownership check that would have
     * caught it runs further down `execute`, after the early return. A guessed
     * identifier therefore read back another driver's submission.
     */
    if (
      !submissionBelongsToCaller(callerDriverId, existingChecklist.driverId)
    ) {
      throw new SubmissionOwnerMismatchError();
    }

    return existingChecklist;
  }

  async execute(
    input: CreateVehicleChecklistProps,
    userId: string,

    // Photos the client already uploaded straight to storage. Only their keys
    // reach this API — the bytes went from the device to the bucket.
    presignedPhotos?: { key: string; fieldName?: string }[],
  ): Promise<VehicleChecklist> {
    // The phone's check of the odometer photo (decision 14.2) is not a field
    // of the row as sent — nor of the AI request's input, which is hashed
    // for idempotency: it lands in its own column, if at all.
    const { device_precheck: devicePrecheck, ...checklistData } = input;

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

    // The company's day, not the server's (decision 1.2). Safe before the
    // replay lookup: a date accepted once can only be further in the past
    // when the same submission is retried.
    assertChecklistNotInTheFuture(checklistData.checklist_date, findBusiness);

    if (checklistData.client_submission_id) {
      const existingChecklist = await this.findReplay(
        checklistData.businessId,
        checklistData.client_submission_id,
        findUser.driverId,
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

    // A driver inspects only a vehicle they may operate: the responsible
    // one, or the one of their released or running route (FLEET-ASSIGN-1,
    // decision 8.2; the rule lives in shared/vehicle/driver-vehicle-access).
    if (findUser.role === "BUSINESS_USER" && findUser.driverId) {
      const allowed = await this.vehicle.canDriverOperateVehicle({
        vehicleId: findVehicle.id,
        driverId: findUser.driverId,
        businessId: checklistData.businessId,
      });

      if (!allowed) {
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

    // The mileage is decided inside the repository's transaction, not here:
    // ahead of the vehicle's odometer as before, OR — for a checklist that
    // arrives after later records, like one the app queued offline — between
    // the readings around its own date (shared/vehicle/odometer-timeline).

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
          "O motorista selecionado está inativo.",
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

    // Set once the replay branch has decided which of them to keep, so the
    // catch below does not decide again.
    let photosSettled = false;

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

      // Kept once (a replay never gets here), only with the odometer photo
      // it is about and only for a company that bought the reading.
      const mileagePrecheck = photoPathsByField.current_mileage?.length
        ? acceptDevicePrecheck(devicePrecheck, {
            kind: "odometer",
            aiAnalysisLimit: findBusiness.ai_analysis_limit,
            providerConfigured: aiProviderConfigured(),
          })
        : null;

      // Add photo paths to checklist data
      const checklistDataWithPhotos = withChecklistDate(
        {
          ...checklistData,
          ...(mileagePrecheck && { mileage_device_precheck: mileagePrecheck }),
          photos: photoPaths,
          photos_by_field:
            Object.keys(photoPathsByField).length > 0
              ? photoPathsByField
              : undefined,
        },
        timeZoneOfBusiness(findBusiness),
      );

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
          // Which readings fall on a later civil day of the company.
          { timeZone: timeZoneOfBusiness(findBusiness) },
        );

      if (!created) {
        // An idempotent replay. The app resends the keys it already uploaded,
        // so the existing checklist usually points at the very objects this
        // attempt attached — deleting "this attempt's" uploads deleted its
        // evidence. Only keys it does not reference belong to nothing.
        await Promise.allSettled(
          unreferencedKeys(
            attachedPhotoPaths,
            checklistPhotoKeys(checklistCreated),
          ).map((photoPath) => this.uploadService.deleteFile(photoPath)),
        );

        photosSettled = true;

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
            checklistCreated.driverId,
          )
        ) {
          throw new SubmissionOwnerMismatchError();
        }

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
            log.error(
              {
                err,
                checklistId: checklistCreated.id,
                businessId: checklistData.businessId,
              },
              "AI checklist verification could not be requested",
            ),
          );
      }

      return checklistCreated;
    } catch (error) {
      // Only on a verdict the retry cannot change. A transient failure is
      // retried by the app with these same keys; deleting them turned a 500
      // into a permanent UPLOADED_FILE_NOT_FOUND and lost the checklist.
      if (
        !databaseCommitted &&
        !photosSettled &&
        isFinalRejection(error, [VehicleMileageInvalidError])
      ) {
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

      log.error({ err: error }, "vehicle checklist could not be created");
      throw new AppError(
        "Houve um erro ao tentar criar o checklist veicular! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { CreateVehicleChecklistUseCase };
