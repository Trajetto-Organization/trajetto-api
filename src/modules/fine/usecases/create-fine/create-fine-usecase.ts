import { inject, injectable } from "tsyringe";

import { IFineRepository } from "../../repositories/IFine-repository";
import { ITrafficViolationCodeRepository } from "../../repositories/ITraffic-violation-code-repository";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { IBranchRepository } from "@/modules/branch/repositories/IBranch-repository";

import { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";
import { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { Fine, CreateFineProps } from "../../dtos/fine-dto";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";
import { BranchNotFoundError } from "@/modules/branch/usecases/errors/branch-not-found-error";

import { DriverNotFoundError } from "@/modules/driver/usecases/errors/driver-not-found-error";
import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";

import { TrafficViolationCodeNotFoundError } from "../errors/traffic-violation-code-not-found-error";

import { FineRegistrationsMobileLocationRequiredError } from "../errors/fine-registrations-mobile-location-required-error";
import { FineLocationNotProvidedAdjustmentValidationError } from "../errors/fine-location-not-provided-adjustment-validation-error";

import { assertFineDates, fineDateFromInput } from "../fine-dates";

import { OutboxService } from "@/shared/notifications/outbox-service";
import { AppError } from "@/shared/errors/AppError";
import { logger } from "@/shared/logging/logger";
import { isUniqueViolation } from "@/shared/http/idempotency-key";
import { timeZoneOfBusiness } from "@/shared/time/business-time-zone";

import database from "@/../infra/database";

@injectable()
class CreateFineUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("BranchRepository")
    private branch: IBranchRepository,
    @inject("DriverRepository")
    private driver: IDriverRepository,
    @inject("VehicleRepository")
    private vehicle: IVehicleRepository,
    @inject("FineRepository")
    private fine: IFineRepository,
    @inject("TrafficViolationCodeRepository")
    private trafficViolationCode: ITrafficViolationCodeRepository,
    @inject("OutboxService")
    private outbox: OutboxService,
  ) {}

  async execute(
    fineData: CreateFineProps,
    userId: string,
    now: Date = new Date(),
  ): Promise<Fine> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findBusiness = await this.business.findBusinessById(
      fineData.businessId,
    );

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    // The same form sent twice — a lost answer, a second click — is the fine
    // it already created, and notifies nobody again (IDEMP-14).
    const replay = await this.replayOf(fineData);

    if (replay) return replay;

    // A branch, driver or vehicle of another company answers exactly like
    // one that does not exist: a distinct refusal confirmed that the id was
    // real somewhere else (decision 8.1).
    const findBranch = await this.branch.findBranchById(fineData.branchId);

    if (!findBranch || findBranch.businessId !== fineData.businessId) {
      throw new BranchNotFoundError();
    }

    const findDriver = await this.driver.findDriverById(fineData.driverId);

    if (!findDriver || findDriver.businessId !== fineData.businessId) {
      throw new DriverNotFoundError();
    }

    const findVehicle = await this.vehicle.findVehicleById(fineData.vehicleId);

    if (!findVehicle || findVehicle.businessId !== fineData.businessId) {
      throw new VehicleNotFoundError();
    }

    const findTrafficViolationCode =
      await this.trafficViolationCode.findTrafficViolationCodeById(
        fineData.trafficViolationCodeId,
      );

    if (!findTrafficViolationCode) {
      throw new TrafficViolationCodeNotFoundError();
    }

    // The days the form picked become the instants they start in the
    // company's zone, and the rules read them there.
    const timeZone = timeZoneOfBusiness(findBusiness);

    fineData.violation_date = fineDateFromInput(
      fineData.violation_date,
      timeZone,
    );
    fineData.due_date = fineDateFromInput(fineData.due_date, timeZone);

    if (fineData.payment_date) {
      fineData.payment_date = fineDateFromInput(
        fineData.payment_date,
        timeZone,
      );
    }

    assertFineDates(fineData, timeZone, now);

    // The code's points when the caller did not say. Zero is an answer: some
    // infractions carry no points on the licence.
    const points = fineData.points ?? findTrafficViolationCode.points;

    // 🆕 GEOLOCATION LOGIC: Validate and process location data
    if (fineData.created_from === "MOBILE_APP") {
      // Mobile: Location is REQUIRED
      if (!fineData.latitude || !fineData.longitude) {
        throw new FineRegistrationsMobileLocationRequiredError();
      }

      if (fineData.location_source === "GPS_MANUAL") {
        // A manual adjustment is checked against the fix it moved from; the
        // schema already bounds the distance.
        if (!fineData.latitude_original || !fineData.longitude_original) {
          throw new FineLocationNotProvidedAdjustmentValidationError();
        }

        // A structured line, so it can be filtered by event and user (OBS-14).
        // Persisting it in the activity trail is a separate decision.
        logger.info(
          { event: "audit.gps_adjusted", entity: "fine", userId },
          "GPS location adjusted by the user",
        );
      } else if (!fineData.location_source) {
        // No source means the GPS fix as captured: it is its own original.
        fineData.location_source = "GPS_AUTO";
        fineData.latitude_original = fineData.latitude;
        fineData.longitude_original = fineData.longitude;
      }
    } else if (fineData.created_from === "WEB_DASHBOARD") {
      // Web: the location is optional and, when given, placed by hand. The
      // original fix and the source are the server's to decide, never the
      // form's.
      fineData.latitude_original = null;
      fineData.longitude_original = null;

      if (fineData.latitude && fineData.longitude) {
        fineData.location_source = "USER_MANUAL";
        fineData.location_edited_by = userId;
        fineData.location_edited_at = now;
      } else {
        fineData.location_source = "NONE";
      }
    }

    try {
      // Fine and outbox event commit together: the notification pipeline
      // picks the event up afterwards, so a crash right here can no longer
      // lose the alert nor announce a fine that was rolled back.
      const fineCreated = await database.$transaction(async (tx) => {
        const created = await this.fine.createFine({ ...fineData, points }, tx);

        await this.outbox.publish(tx, {
          topic: "fine.created",
          aggregateType: "fine",
          aggregateId: created.id,
          businessId: fineData.businessId,
          actorId: userId,
          payload: {
            fineId: created.id,
            businessId: fineData.businessId,
            amount: Number(created.amount),
            points: created.points,
            violationDate: new Date(created.violation_date).toISOString(),
            timeZone,
            location: created.location || null,
            observation: (created.observation as string) || null,
            vehiclePlate: findVehicle.license_plate,
            driverName: findDriver.name,
            branchName: findBranch.corporate_reason,
            violationCode: `${findTrafficViolationCode.code}-${findTrafficViolationCode.sub_code}`,
            actor: {
              id: userId,
              name: findUser.name,
              email: findUser.email,
              role: findUser.role,
            },
          },
        });

        return created;
      });

      return fineCreated;
    } catch (error) {
      // The twin of this submission committed after the replay check: the
      // insert met the unique key, and the twin's fine is the answer.
      if (isUniqueViolation(error)) {
        const replay = await this.replayOf(fineData);

        if (replay) return replay;
      }

      throw new AppError(
        "Houve um erro ao tentar registrar a multa! Por favor, tente novamente.",
        500,
      );
    }
  }

  private async replayOf(fineData: CreateFineProps): Promise<Fine | null> {
    if (!fineData.client_submission_id) return null;

    return this.fine.findFineBySubmissionId(
      fineData.businessId,
      fineData.client_submission_id,
    );
  }
}

export { CreateFineUseCase };
