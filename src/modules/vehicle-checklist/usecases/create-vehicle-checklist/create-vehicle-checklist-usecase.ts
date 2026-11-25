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
import type { IRouteRepository } from "@/modules/route/repositories/IRoute-repository";
import type { ClientVersion } from "@/shared/http/client-version";
import {
  arrivalBeforeRouteEndRefusal,
  arrivalChecklistRefusal,
  checklistPhaseRefusal,
  enforcesArrivalChecklistRule,
  routeLinkRefusal,
  routeProvesCustody,
} from "@/shared/vehicle/route-link";
import {
  checklistDefects,
  hasDefects,
} from "@/shared/vehicle/checklist-defects";
import {
  activeBranchLookups,
  announceRecordBranchGap,
  driverRecordBranchRequired,
  resolveActiveRecordBranchId,
  resolveRecordBranchId,
} from "@/shared/vehicle/record-branch";
import { resolveRecordOrigin } from "@/shared/vehicle/record-origin";
import { announceVehicleChanged } from "@/shared/vehicle/vehicle-realtime";

const log = logger.child({ component: "vehicle-checklist" });

/** The route a checklist names, once it holds; null when it names none. */
type LinkedRoute = Awaited<ReturnType<IRouteRepository["findRouteById"]>>;

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
    // Plan of 02/11/2026 (C4/F3): the route a checklist names. Optional so
    // callers built before it keep working; the container always provides it.
    @inject("RouteRepository")
    private route?: Pick<IRouteRepository, "findRouteById">,
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

  /**
   * The route a checklist names (C4/F3): refused unless it is this driver's,
   * with this vehicle (shared/vehicle/route-link.ts). The route when one was
   * named and holds — which also answers the driver's custody of the
   * vehicle, after the route ended too — and null when none was named.
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
    input: CreateVehicleChecklistProps,
    userId: string,

    // Photos the client already uploaded straight to storage. Only their keys
    // reach this API — the bytes went from the device to the bucket.
    presignedPhotos?: { key: string; fieldName?: string }[],

    // The app build that sent it (x-trajetto-client-version), null when the
    // request does not say: its `contract` decides whether an early arrival
    // checklist is refused or only flagged.
    client?: ClientVersion | null,
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

    // A driver's checklist is the app's whatever the body says; anybody
    // else's keeps what was sent and, when nothing was, is the app's if it
    // carries a key (an office user on the app build that names no origin)
    // and WEB_DASHBOARD if not (the web's form sends neither). Stored, and
    // named in the outbox event below (shared/vehicle/record-origin.ts).
    checklistData.created_from = resolveRecordOrigin(
      findUser,
      checklistData.created_from,
      checklistData.client_submission_id,
    );

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

    // C4/F3: a checklist made for a route names its moment, and the route
    // must be this driver's, with this vehicle. The departure never asks the
    // route's status (decision D08): one queued offline may land after the
    // start. The arrival does, for a driver, right below (custody is asked
    // further down).
    const phaseRefusal = checklistPhaseRefusal(
      checklistData.routeId,
      checklistData.phase,
    );

    if (phaseRefusal) throw phaseRefusal;

    const linkedRoute = await this.assertRouteLink(
      checklistData.routeId,
      checklistData.businessId,
      // A driver's own records are theirs whatever the body says (forced
      // below); a manager names the driver in the form.
      findUser.driverId ?? checklistData.driverId,
      findVehicle.id,
    );

    // The arrival closes the route's work: a driver makes it once the route
    // left and every stop is resolved (shared/vehicle/route-link.ts). Refused
    // only for a build that holds it the same way (contract 5 on); an older
    // one — mobile `main` sends no header — offered it at any time and its
    // outbox would fail what it never avoided, so that checklist is recorded
    // and the trail says how many stops were still open. The office, which
    // types arrivals after the fact, is never asked: a driver is a
    // BUSINESS_USER with a driver, as resolveRecordOrigin reads it above.
    const callerIsDriver =
      findUser.role === "BUSINESS_USER" && Boolean(findUser.driverId);
    const arrivalRefusal =
      callerIsDriver && linkedRoute
        ? arrivalChecklistRefusal(checklistData.phase, linkedRoute)
        : null;
    const enforcesArrivalRule = enforcesArrivalChecklistRule(client?.contract);

    if (arrivalRefusal && enforcesArrivalRule) {
      throw arrivalRefusal;
    }

    const arrivalOpenStops = arrivalRefusal?.openStops;

    // The date the row will carry: a bare day starts in the company's zone,
    // and none sent is the database's now().
    const checklistDate = withChecklistDate(
      { checklist_date: checklistData.checklist_date },
      timeZoneOfBusiness(findBusiness),
    ).checklist_date;
    const recordDate = checklistDate ? new Date(checklistDate) : new Date();

    // Every stop final is not enough: the arrival must also be dated after
    // the route's last delivery or failed attempt. One saved offline before
    // the dispatcher added a stop waits in the queue while that stop is
    // open, and the driver then drives to it; a draft held while the route
    // reopened keeps its date. Refused for good, for the same builds as
    // above — the app's route step asks for a new one; an older build's is
    // recorded as before (shared/vehicle/route-link.ts).
    const lateArrival =
      callerIsDriver && linkedRoute && !arrivalRefusal && enforcesArrivalRule
        ? arrivalBeforeRouteEndRefusal(
            checklistData.phase,
            linkedRoute,
            recordDate,
          )
        : null;

    if (lateArrival) throw lateArrival;

    // A driver inspects only a vehicle they may operate: the responsible
    // one, or the one of their released or running route (FLEET-ASSIGN-1,
    // decision 8.2; the rule lives in shared/vehicle/driver-vehicle-access).
    // The route the checklist names — theirs, with this vehicle — is that
    // proof too, after it ended: the substitute who drove truck X on it
    // still does its arrival checklist. Only for a checklist dated while the
    // route had the truck (routeProvesCustody): an old, cancelled or never
    // released route opens nothing.
    const routeProof =
      linkedRoute !== null &&
      routeProvesCustody(
        linkedRoute,
        recordDate,
        timeZoneOfBusiness(findBusiness),
      );

    if (findUser.role === "BUSINESS_USER" && findUser.driverId && !routeProof) {
      const allowed = await this.vehicle.canDriverOperateVehicle({
        vehicleId: findVehicle.id,
        driverId: findUser.driverId,
        businessId: checklistData.businessId,
      });

      if (!allowed) {
        throw new VehicleNotAssignedToDriverError();
      }
    }

    // The driver's own record, when the caller is one: what the dispatcher
    // is told names them.
    let filedByDriver: { name: string | null } | null = null;

    // Auto-populate branchId and driverId for driver users
    if (findUser.driverId) {
      const driverUser = await this.driver.findDriverById(findUser.driverId);
      if (driverUser) {
        checklistData.driverId = findUser.driverId;
        filedByDriver = { name: driverUser.name ?? null };

        // Drivers never pick the branch, and theirs goes under an ACTIVE one
        // only: vehicle → driver → the company's single active branch,
        // skipping what is switched off (shared/vehicle/record-branch, wave
        // 3.7). A blank or closed branch must not strand the driver.
        checklistData.branchId =
          (await resolveActiveRecordBranchId(
            {
              vehicleBranchId: findVehicle.branchId,
              driverBranchId: driverUser.branchId,
            },
            activeBranchLookups(this.branch, checklistData.businessId),
          )) ?? undefined;
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

    // A manager who left the branch blank gets the same resolution, with
    // the driver they named (validated above, so of this company).
    if (!checklistData.branchId && !findUser.driverId) {
      const namedDriver = checklistData.driverId
        ? await this.driver.findDriverById(checklistData.driverId)
        : null;

      checklistData.branchId =
        (await resolveRecordBranchId(
          {
            vehicleBranchId: findVehicle.branchId,
            driverBranchId: namedDriver?.branchId,
          },
          () => this.branch.findSoleActiveBranchId(checklistData.businessId),
        )) ?? undefined;
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

    // Only when even the company's branches name none (no active branch, or
    // several): the route release warns the dispatcher before this
    // (ROUTE_BRANCH_REQUIRED), and what changed after the release is told to
    // the dispatcher now, once per route and moment (wave 3.7).
    if (!checklistData.branchId) {
      if (filedByDriver) {
        if (linkedRoute) {
          await announceRecordBranchGap(this.outbox, {
            route: linkedRoute,
            businessId: checklistData.businessId,
            actorId: userId,
            record: "CHECKLIST",
            phase:
              checklistData.phase === "ROUTE_END" ? "ROUTE_END" : "ROUTE_START",
            driverName: filedByDriver.name,
            vehiclePlate: findVehicle.license_plate,
          });
        }

        throw driverRecordBranchRequired("CHECKLIST");
      }

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
      // F2: what the inspection found wrong, if anything. Only a defect
      // alerts the fleet; a clean checklist stays activity-only.
      const defects = checklistDefects(checklistData);

      const { checklist: checklistCreated, created } =
        await this.vehicleChecklist.createVehicleChecklistWithMileage(
          checklistDataWithPhotos,
          async (tx, checklist) => {
            await this.outbox.publish(tx, {
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
                origin: checklistData.created_from,
                // Only on a driver's early arrival from an older build.
                ...(arrivalOpenStops !== undefined && { arrivalOpenStops }),
              },
            });

            // In the same commit as the checklist, so the alert can neither
            // ring about a rolled-back inspection nor miss a recorded one.
            if (hasDefects(defects)) {
              await this.outbox.publish(tx, {
                topic: "vehicle-checklist.defects_found",
                aggregateType: "vehicle-checklist",
                aggregateId: checklist.id,
                businessId: checklistData.businessId,
                actorId: userId,
                eventKey: `vehicle-checklist.defects_found:${checklist.id}`,
                payload: {
                  checklistId: checklist.id,
                  businessId: checklistData.businessId,
                  vehicleId: findVehicle.id,
                  vehiclePlate: findVehicle.license_plate,
                  vehicleDescription: findVehicle.description,
                  responsibleUserId: findVehicle.responsibleUserId ?? null,
                  defects: defects.items,
                  verdict: defects.verdict,
                },
              });
            }
          },
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

      // Committed: the reading may have moved the vehicle's odometer, which
      // the vehicle lists show. A replay above wrote nothing new.
      announceVehicleChanged(checklistData.businessId);

      // Said once the row is recorded, never for a request a later check
      // refused (custody, branch, mileage): the outbox retries those, and
      // each retry would count again. A resend of this one is answered by the
      // replay lookup and never gets here.
      if (arrivalOpenStops !== undefined) {
        log.warn(
          {
            checklistId: checklistCreated.id,
            businessId: checklistData.businessId,
            routeId: checklistData.routeId,
            openStops: arrivalOpenStops,
            clientContract: client?.contract ?? null,
          },
          "Early arrival checklist from a build without the arrival rule: recorded and flagged",
        );
      }

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
