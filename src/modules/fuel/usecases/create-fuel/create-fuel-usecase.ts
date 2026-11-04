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
import { aiProviderConfigured } from "@/shared/ai/ai-provider";
import { acceptDevicePrecheck } from "@/shared/ai-precheck/device-precheck";
import { Fuel, CreateFuelProps } from "../../dtos/fuel-dto";

import { UploadService } from "@/shared/services/upload-service";
import { assertRefuelingNotInTheFuture, businessTimeZone } from "../fuel-rules";

import { pickedDateFromInput } from "@/shared/vehicle/record-dates";

import { calculateDistance } from "@/shared/utils/geolocation";
import { logger } from "@/shared/logging/logger";
import { AIAnalysisService } from "@/shared/ai/ai-analysis-service";
import {
  isFinalRejection,
  unreferencedKeys,
} from "@/shared/services/presigned-ownership";

import type { IRouteRepository } from "@/modules/route/repositories/IRoute-repository";
import {
  routeLinkRefusal,
  routeProvesCustody,
} from "@/shared/vehicle/route-link";
import {
  activeBranchLookups,
  announceRecordBranchGap,
  driverRecordBranchRequired,
  resolveActiveRecordBranchId,
  resolveRecordBranchId,
} from "@/shared/vehicle/record-branch";

const log = logger.child({ component: "fuel" });

/** The route a refuelling names, once it holds; null when it names none. */
type LinkedRoute = Awaited<ReturnType<IRouteRepository["findRouteById"]>>;

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
    // Plan of 02/11/2026 (C5/F3): the route a refuelling names. Optional so
    // callers built before it keep working; the container always provides it.
    @inject("RouteRepository")
    private route?: Pick<IRouteRepository, "findRouteById">,
  ) {}

  /**
   * The fueling an earlier attempt already recorded under this key, if any.
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
  ): Promise<Fuel | null> {
    const existingFuel = await this.fuel.findBySubmissionId(
      businessId,
      submissionId,
    );

    if (!existingFuel) return null;

    /**
     * A replay has to belong to the driver replaying it.
     *
     * The key is unique per `(businessId, client_submission_id)`, so the
     * tenant is already safe — but inside one carrier this returned whatever
     * record carried the key, and the driver-ownership check that would have
     * caught it runs further down `execute`, after the early return. A guessed
     * identifier therefore read back another driver's submission.
     */
    if (!submissionBelongsToCaller(callerDriverId, existingFuel.driverId)) {
      throw new SubmissionOwnerMismatchError();
    }

    return existingFuel;
  }

  /**
   * The route a refuelling names (C5/F3): refused unless it is this
   * driver's, with this vehicle (shared/vehicle/route-link.ts). The route
   * when one was named and holds — which also answers the driver's custody
   * of the vehicle, after the route ended too — and null when none was.
   */
  private async assertRouteLink(
    routeId: string | null | undefined,
    businessId: string,
    driverId: string | null | undefined,
    vehicleId: string,
  ): Promise<LinkedRoute> {
    if (!routeId) return null;

    if (!this.route) throw new Error("RouteRepository was not injected");

    const route = await this.route.findRouteById(routeId, businessId);
    const refusal = routeLinkRefusal(route, { driverId, vehicleId });

    if (refusal) throw refusal;

    return route;
  }

  async execute(
    input: CreateFuelProps,
    userId: string,

    // The odometer photo, already in storage. Mandatory on create — the
    // controller refuses the request without it.
    presignedPhoto?: { key: string },
  ): Promise<Fuel> {
    // The phone's check of the odometer photo (decision 14.2) is not a field
    // of the row as sent: it lands in its own column, if at all.
    const { device_precheck: devicePrecheck, ...fuelData } = input;

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

    // A replay answers first (below), even from a client whose clock moved:
    // the record exists and resending it must not turn into a refusal.
    if (fuelData.client_submission_id) {
      const existingFuel = await this.findReplay(
        fuelData.businessId,
        fuelData.client_submission_id,
        findUser.driverId,
      );

      if (existingFuel) return existingFuel;
    }

    assertRefuelingNotInTheFuture(fuelData.refueling_date, findBusiness);

    // A bare day becomes the instant it starts in the company's zone: as a
    // string it reached Prisma and answered 500.
    fuelData.refueling_date = pickedDateFromInput(
      fuelData.refueling_date,
      businessTimeZone(findBusiness),
    );

    // Validate vehicle exists and belongs to business
    const findVehicle = await this.vehicle.findVehicleById(fuelData.vehicleId);

    if (!findVehicle) {
      throw new VehicleNotFoundError();
    }

    if (findVehicle.businessId !== fuelData.businessId) {
      throw new VehicleNotBelongBusinessError();
    }

    // C5/F3: a refuelling made from the route belongs to it — the route must
    // be this driver's, with this vehicle. Never its status here: one queued
    // offline may land after the route ended (custody is asked below). A driver's own records are
    // theirs whatever the body says (forced below); a manager names the
    // driver in the form.
    const linkedRoute = await this.assertRouteLink(
      fuelData.routeId,
      fuelData.businessId,
      findUser.driverId ?? fuelData.driverId,
      findVehicle.id,
    );

    // A driver fuels only a vehicle they may operate: the responsible one,
    // or the one of their released or running route (FLEET-ASSIGN-1,
    // decision 8.2; the rule lives in shared/vehicle/driver-vehicle-access).
    // The route the refuelling names — theirs, with this vehicle — is that
    // proof too, after it ended, for a refuelling dated while it had the
    // truck (routeProvesCustody): an old or cancelled route opens nothing.
    const routeProof =
      linkedRoute !== null &&
      routeProvesCustody(
        linkedRoute,
        new Date(fuelData.refueling_date),
        businessTimeZone(findBusiness),
      );

    if (findUser.role === "BUSINESS_USER" && findUser.driverId && !routeProof) {
      const allowed = await this.vehicle.canDriverOperateVehicle({
        vehicleId: findVehicle.id,
        driverId: findUser.driverId,
        businessId: fuelData.businessId,
      });

      if (!allowed) {
        throw new VehicleNotAssignedToDriverError();
      }
    }

    // The driver's own record, when the caller is one: what the dispatcher
    // is told names them.
    let filedByDriver: { name: string | null } | null = null;

    // Auto-populate branchId, driverId, and fuelTypeId for driver users
    if (findUser.driverId) {
      const driverUser = await this.driver.findDriverById(findUser.driverId);
      if (driverUser) {
        fuelData.driverId = findUser.driverId;
        filedByDriver = { name: driverUser.name ?? null };

        // Force fuelTypeId to match vehicle's fuel type (drivers cannot change it)
        fuelData.fuelTypeId = findVehicle.fuelTypeId;

        // Drivers never pick the branch, and theirs goes under an ACTIVE one
        // only: vehicle → driver → the company's single active branch,
        // skipping what is switched off (shared/vehicle/record-branch, wave
        // 3.7). A blank or closed branch must not strand the driver.
        fuelData.branchId =
          (await resolveActiveRecordBranchId(
            {
              vehicleBranchId: findVehicle.branchId,
              driverBranchId: driverUser.branchId,
            },
            activeBranchLookups(this.branch, fuelData.businessId),
          )) ?? undefined;
      }
    }

    // Validate vehicle status (only ACTIVE or IN_ROUTE vehicles can be fueled)
    if (findVehicle.status !== "ACTIVE" && findVehicle.status !== "IN_ROUTE") {
      throw new FuelVehicleInvalidStatusForFuelError();
    }

    // The mileage is decided inside the repository's transaction, not here:
    // ahead of the vehicle's odometer as before, OR — for a fueling that
    // arrives after later records, like one the app queued offline — between
    // the readings around its own date (shared/vehicle/odometer-timeline).
    // Compared with the vehicle as it is now, that late fueling could never
    // be entered at all.

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
          "O motorista selecionado está inativo.",
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

    // A manager who left the branch blank gets the same resolution, with
    // the driver they named (validated above, so of this company).
    if (!fuelData.branchId && !findUser.driverId) {
      const namedDriver = fuelData.driverId
        ? await this.driver.findDriverById(fuelData.driverId)
        : null;

      fuelData.branchId =
        (await resolveRecordBranchId(
          {
            vehicleBranchId: findVehicle.branchId,
            driverBranchId: namedDriver?.branchId,
          },
          () => this.branch.findSoleActiveBranchId(fuelData.businessId),
        )) ?? undefined;
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

    // Only when even the company's branches name none (no active branch, or
    // several): the route release warns the dispatcher before this
    // (ROUTE_BRANCH_REQUIRED), and a refuelling on a route after the release
    // is told to the dispatcher now, once per route (wave 3.7).
    if (!fuelData.branchId) {
      if (filedByDriver) {
        if (linkedRoute) {
          await announceRecordBranchGap(this.outbox, {
            route: linkedRoute,
            businessId: fuelData.businessId,
            actorId: userId,
            record: "FUEL",
            phase: null,
            driverName: filedByDriver.name,
            vehiclePlate: findVehicle.license_plate,
          });
        }

        throw driverRecordBranchRequired("FUEL");
      }

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
          // The service order's code for the same refusal (decision 11.3).
          throw new AppError(
            `A localização editada está ${Math.round(distance)}m distante da capturada pelo GPS. Máximo permitido: 500m. Possível inconsistência detectada.`,
            400,
            "LOCATION_ADJUSTMENT_TOO_FAR",
          );
        }

        // A structured line, so it can be filtered by event and user (OBS-14).
        // Persisting it in the activity trail is a separate decision.
        logger.info(
          {
            event: "audit.gps_adjusted",
            entity: "fuel",
            userId,
            distanceMeters: Math.round(distance),
          },
          "GPS location adjusted by the user",
        );
      } else if (!fuelData.location_source) {
        // No source: the point came from the GPS untouched, so the final
        // location is also the original one.
        fuelData.location_source = "GPS_AUTO";

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
      // Kept with the record, once (a replay never gets here), and only for
      // a company that bought the reading. It never moves the verification.
      const odometerPrecheck = uploadedPhotoPath
        ? acceptDevicePrecheck(devicePrecheck, {
            kind: "odometer",
            aiAnalysisLimit: findBusiness.ai_analysis_limit,
            providerConfigured: aiProviderConfigured(),
          })
        : null;

      const fuelDataWithPhoto: any = {
        ...fuelData,
        odometer_photo: uploadedPhotoPath,
        ...(odometerPrecheck && { odometer_device_precheck: odometerPrecheck }),
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
      const { fuel: fuelCreated, created } =
        await this.fuel.createFuelWithMileage(
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
          // The company's day decides which readings are "after" a web date.
          { timeZone: businessTimeZone(findBusiness) },
        );

      if (!created) {
        // An idempotent replay. The app resends the key it already uploaded,
        // so the existing fueling usually points at the very object this
        // attempt attached — deleting it deleted that record's odometer
        // evidence. Only a key it does not reference belongs to nothing.
        const orphans = uploadedPhotoPath
          ? unreferencedKeys([uploadedPhotoPath], [fuelCreated.odometer_photo])
          : [];

        await Promise.allSettled(
          orphans.map((photoPath) => this.uploadService.deleteFile(photoPath)),
        );

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
          !submissionBelongsToCaller(findUser.driverId, fuelCreated.driverId)
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
            log.error(
              { err, fuelId: fuelCreated.id, businessId: fuelData.businessId },
              "AI fuel verification could not be requested",
            ),
          );
      }

      return fuelCreated;
    } catch (error) {
      // Only on a verdict the retry cannot change: the app retries a
      // transient failure with this same key, and a deleted object turned
      // that retry into a permanent UPLOADED_FILE_NOT_FOUND.
      if (
        uploadedPhotoPath &&
        !databaseCommitted &&
        isFinalRejection(error, [VehicleMileageInvalidError])
      ) {
        await this.uploadService.deleteFile(uploadedPhotoPath);
      }

      // The vehicle removed while the refueling was being placed: its own
      // answer, not a 500.
      if (
        error instanceof VehicleMileageInvalidError ||
        error instanceof VehicleNotFoundError
      ) {
        throw error;
      }

      if (error instanceof AppError) {
        throw error;
      }

      log.error({ err: error }, "fuel record could not be created");
      throw new AppError(
        "Houve um erro ao tentar criar o abastecimento! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { CreateFuelUseCase };
