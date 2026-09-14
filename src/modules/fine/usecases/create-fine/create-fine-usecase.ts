import { inject, injectable } from "tsyringe";

import { IFineRepository } from "../../repositories/IFine-repository";
import { ITrafficViolationCodeRepository } from "../../repositories/ITraffic-violation-code-repository";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { IBranchRepository } from "@/modules/branch/repositories/IBranch-repository";

import { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";
import { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { BranchNotBelongBusinessError } from "@/modules/branch/usecases/errors/branch-not-belong-business-error";
import { DriverNotBelongBusinessError } from "@/modules/driver/usecases/errors/driver-not-belong-business-error";

import { VehicleNotBelongBusinessError } from "@/modules/vehicle/usecases/errors/vehicle-not-belong-business-error";

import { Fine, CreateFineProps } from "../../dtos/fine-dto";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";
import { BranchNotFoundError } from "@/modules/branch/usecases/errors/branch-not-found-error";

import { DriverNotFoundError } from "@/modules/driver/usecases/errors/driver-not-found-error";
import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";

import { FineDateInfractionCannotBeFutureError } from "../errors/fine-date-infraction-cannot-be-future-error";
import { FineDueDateMustBeAfterInfractionError } from "../errors/fine-due-date-must-be-after-infraction-error";

import { TrafficViolationCodeNotFoundError } from "../errors/traffic-violation-code-not-found-error";

import { FinePaymentDateCannotBeEarlierInfractionError } from "../errors/fine-payment-date-cannot-be-earlier-infraction-error";
import { FineRegistrationsMobileLocationRequiredError } from "../errors/fine-registrations-mobile-location-required-error";

import { FineLocationNotProvidedAdjustmentValidationError } from "../errors/fine-location-not-provided-adjustment-validation-error";

import { OutboxService } from "@/shared/notifications/outbox-service";
import { AppError } from "@/shared/errors/AppError";

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

  async execute(fineData: CreateFineProps, userId: string): Promise<Fine> {
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

    const findBranch = await this.branch.findBranchById(fineData.branchId);

    if (!findBranch) {
      throw new BranchNotFoundError();
    }

    if (findBranch.businessId !== fineData.businessId) {
      throw new BranchNotBelongBusinessError();
    }

    const findDriver = await this.driver.findDriverById(fineData.driverId);

    if (!findDriver) {
      throw new DriverNotFoundError();
    }

    if (findDriver.businessId !== fineData.businessId) {
      throw new DriverNotBelongBusinessError();
    }

    const findVehicle = await this.vehicle.findVehicleById(fineData.vehicleId);

    if (!findVehicle) {
      throw new VehicleNotFoundError();
    }

    if (findVehicle.businessId !== fineData.businessId) {
      throw new VehicleNotBelongBusinessError();
    }

    const findTrafficViolationCode =
      await this.trafficViolationCode.findTrafficViolationCodeById(
        fineData.trafficViolationCodeId,
      );

    if (!findTrafficViolationCode) {
      throw new TrafficViolationCodeNotFoundError();
    }

    const violationDate = new Date(fineData.violation_date);
    const dueDate = new Date(fineData.due_date);

    const today = new Date();

    if (violationDate > today) {
      throw new FineDateInfractionCannotBeFutureError();
    }

    if (dueDate <= violationDate) {
      throw new FineDueDateMustBeAfterInfractionError();
    }

    if (fineData.payment_date) {
      const paymentDate = new Date(fineData.payment_date);

      if (paymentDate < violationDate) {
        throw new FinePaymentDateCannotBeEarlierInfractionError();
      }
    }

    if (!fineData.points) {
      fineData.points = findTrafficViolationCode.points;
    }

    // 🆕 GEOLOCATION LOGIC: Validate and process location data
    if (fineData.created_from === "MOBILE_APP") {
      // Mobile: Location is REQUIRED
      if (!fineData.latitude || !fineData.longitude) {
        throw new FineRegistrationsMobileLocationRequiredError();
      }

      // 🆕 VALIDATE DISTANCE IF GPS_MANUAL (manual adjustment)
      if (fineData.location_source === "GPS_MANUAL") {
        // Verifica se temos a localização original
        if (!fineData.latitude_original || !fineData.longitude_original) {
          throw new FineLocationNotProvidedAdjustmentValidationError();
        }

        // A validação de distância já é feita pelo schema com isWithinAllowedDistance
        // Log de auditoria (opcional)
        console.log(`[AUDIT] GPS ajustado por ${userId} na multa`);
      } else if (!fineData.location_source) {
        // Se não tem source, é GPS automático
        fineData.location_source = "GPS_AUTO";

        // Copia localização final para original (não foi editada)
        fineData.latitude_original = fineData.latitude;
        fineData.longitude_original = fineData.longitude;
      }
    } else if (fineData.created_from === "WEB_DASHBOARD") {
      // Web: Location is OPTIONAL
      if (fineData.latitude && fineData.longitude) {
        fineData.location_source = "USER_MANUAL";
      } else {
        fineData.location_source = "NONE";
      }
    }

    // Add audit fields for web dashboard manual location
    if (
      fineData.created_from === "WEB_DASHBOARD" &&
      fineData.latitude &&
      fineData.longitude
    ) {
      (fineData as any).location_edited_by = userId;
      (fineData as any).location_edited_at = new Date();
    }

    try {
      // Fine and outbox event commit together: the notification pipeline
      // picks the event up afterwards, so a crash right here can no longer
      // lose the alert nor announce a fine that was rolled back.
      const fineCreated = await database.$transaction(async (tx) => {
        const created = await this.fine.createFine(fineData, tx);

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
            points: (created.points as number) ?? null,
            violationDate: new Date(created.violation_date).toISOString(),
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
      throw new AppError(
        "Houve um erro ao tentar registrar a multa! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { CreateFineUseCase };
