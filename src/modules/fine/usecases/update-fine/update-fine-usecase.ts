import { inject, injectable } from "tsyringe";

import { IFineRepository } from "../../repositories/IFine-repository";
import { ITrafficViolationCodeRepository } from "../../repositories/ITraffic-violation-code-repository";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { IBranchRepository } from "@/modules/branch/repositories/IBranch-repository";
import { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";

import { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { Fine, UpdateFineProps } from "../../dtos/fine-dto";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BranchNotFoundError } from "@/modules/branch/usecases/errors/branch-not-found-error";

import { DriverNotFoundError } from "@/modules/driver/usecases/errors/driver-not-found-error";
import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";

import { TrafficViolationCodeNotFoundError } from "../errors/traffic-violation-code-not-found-error";

import { assertFineDates, fineDateFromInput } from "../fine-dates";
import { FineNotFoundError } from "../errors/fine-not-found-error";

import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";
import { NotificationService } from "@/shared/services/notification-service";

import { AppError } from "@/shared/errors/AppError";
import { formatCurrency } from "@/shared/utils/format-values";
import { loadBusinessTimeZone } from "@/shared/time/business-time-zone";

/** Whether a coordinate pair differs from the stored one. */
function movedFrom(
  stored: { latitude?: number | null; longitude?: number | null },
  latitude: number,
  longitude: number,
): boolean {
  return stored.latitude !== latitude || stored.longitude !== longitude;
}

@injectable()
class UpdateFineUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("FineRepository")
    private fine: IFineRepository,
    @inject("BranchRepository")
    private branch: IBranchRepository,
    @inject("DriverRepository")
    private driver: IDriverRepository,
    @inject("VehicleRepository")
    private vehicle: IVehicleRepository,
    @inject("TrafficViolationCodeRepository")
    private trafficViolationCode: ITrafficViolationCodeRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute(
    fineData: UpdateFineProps,
    fineId: string,
    userId: string,
    businessId: string,
    now: Date = new Date(),
  ): Promise<Fine> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    assertTenantAccess(findUser, businessId);

    const existingFine = await this.fine.findFineById(fineId);

    // The same 404 for "does not exist" and "not yours", as the delete: a
    // distinct 403 confirmed that another company's fine existed.
    if (!existingFine || existingFine.businessId !== businessId) {
      throw new FineNotFoundError();
    }

    // Another company's branch, driver or vehicle reads as one that does not
    // exist, like on the create (decision 8.1).
    if (fineData.branchId) {
      const findBranch = await this.branch.findBranchById(fineData.branchId);

      if (!findBranch || findBranch.businessId !== businessId) {
        throw new BranchNotFoundError();
      }
    }

    if (fineData.driverId) {
      const findDriver = await this.driver.findDriverById(fineData.driverId);

      if (!findDriver || findDriver.businessId !== businessId) {
        throw new DriverNotFoundError();
      }
    }

    if (fineData.vehicleId) {
      const findVehicle = await this.vehicle.findVehicleById(
        fineData.vehicleId,
      );

      if (!findVehicle || findVehicle.businessId !== businessId) {
        throw new VehicleNotFoundError();
      }
    }

    if (fineData.trafficViolationCodeId) {
      const newTrafficViolationCode =
        await this.trafficViolationCode.findTrafficViolationCodeById(
          fineData.trafficViolationCodeId,
        );

      if (!newTrafficViolationCode) {
        throw new TrafficViolationCodeNotFoundError();
      }

      // A new code brings its points unless the caller set them.
      if (
        fineData.trafficViolationCodeId !==
          existingFine.trafficViolationCodeId &&
        fineData.points === undefined
      ) {
        fineData.points = newTrafficViolationCode.points;
      }
    }

    const timeZone = await loadBusinessTimeZone(this.business, businessId);

    // A picked day is stored as the instant it starts in the company's zone.
    if (fineData.violation_date) {
      fineData.violation_date = fineDateFromInput(fineData.violation_date, timeZone);
    }

    if (fineData.due_date) {
      fineData.due_date = fineDateFromInput(fineData.due_date, timeZone);
    }

    if (fineData.payment_date) {
      fineData.payment_date = fineDateFromInput(fineData.payment_date, timeZone);
    }

    // The dates as they will be saved, checked together: the edit used to
    // compare only the fields it received, so moving the infraction after
    // the recorded payment, or into the future, went through.
    assertFineDates(
      {
        violation_date: fineData.violation_date ?? existingFine.violation_date,
        due_date: fineData.due_date ?? existingFine.due_date,
        payment_date:
          fineData.payment_date === undefined
            ? existingFine.payment_date
            : fineData.payment_date,
      },
      timeZone,
      now,
    );

    // 📍 The location, when the request names it. Placing it by hand signs
    // the edit; saving the form with the same point does not re-sign it.
    if ("latitude" in fineData || "longitude" in fineData) {
      const { latitude, longitude } = fineData;

      if (typeof latitude === "number" && typeof longitude === "number") {
        if (movedFrom(existingFine, latitude, longitude)) {
          fineData.location_source = "USER_MANUAL";
          fineData.location_edited_by = userId;
          fineData.location_edited_at = now;
        }
      } else if (latitude === null || longitude === null) {
        fineData.latitude = null;
        fineData.longitude = null;
        fineData.location_source = "NONE";
        fineData.latitude_original = null;
        fineData.longitude_original = null;
      }
    }

    try {
      const updatedFine = await this.fine.updateFine({
        fineData,
        fineId,
        businessId,
      });

      // Process activity asynchronously without blocking the main flow
      this.notificationService.createActivityIfEnabled({
        type: "Multa",
        action: "update",
        entityId: updatedFine.id,
        description: `Multa atualizada | Valor: ${formatCurrency(Number(updatedFine.amount))} | ID: ${updatedFine.id}`,
        status: "Atualizado",
        performedBy: userId,
        businessId: businessId,
      });

      return updatedFine;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar atualizar a multa! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { UpdateFineUseCase };
