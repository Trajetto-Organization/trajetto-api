import { inject, injectable } from "tsyringe";

import { IFineRepository } from "../../repositories/IFine-repository";
import { ITrafficViolationCodeRepository } from "../../repositories/ITraffic-violation-code-repository";

import { IBranchRepository } from "@/modules/branch/repositories/IBranch-repository";
import { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";

import { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { Fine, UpdateFineProps } from "../../dtos/fine-dto";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BranchNotFoundError } from "@/modules/branch/usecases/errors/branch-not-found-error";

import { DriverNotFoundError } from "@/modules/driver/usecases/errors/driver-not-found-error";
import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";

import { BranchNotBelongBusinessError } from "@/modules/branch/usecases/errors/branch-not-belong-business-error";
import { DriverNotBelongBusinessError } from "@/modules/driver/usecases/errors/driver-not-belong-business-error";

import { FineNotFoundError } from "../errors/fine-not-found-error";

import { VehicleNotBelongBusinessError } from "@/modules/vehicle/usecases/errors/vehicle-not-belong-business-error";
import { TrafficViolationCodeNotFoundError } from "../errors/traffic-violation-code-not-found-error";

import { FineDueDateMustBeAfterInfractionError } from "../errors/fine-due-date-must-be-after-infraction-error";
import { FinePaymentDateCannotBeEarlierInfractionError } from "../errors/fine-payment-date-cannot-be-earlier-infraction-error";

import { FineDueDateInfractionCannotBeLaterError } from "../errors/fine-due-date-infraction-cannot-be-later-error";
import { FineUserNotAllowedChangeError } from "../errors/fine-user-not-allowed-change-error";

import { FineDueDateMustBeLaterInfractionError } from "../errors/fine-due-date-must-be-later-infraction-error";
import { NotificationService } from "@/shared/services/notification-service";

import { AppError } from "@/shared/errors/AppError";
import { formatCurrency } from "@/config/format-values";

@injectable()
class UpdateFineUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
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
  ): Promise<Fine> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const existingFine = await this.fine.findFineById(fineId);

    if (!existingFine) {
      throw new FineNotFoundError();
    }

    if (
      findUser.role !== "MASTER" &&
      existingFine.businessId !== findUser.businessId
    ) {
      throw new FineUserNotAllowedChangeError();
    }

    if (fineData.branchId) {
      const findBranch = await this.branch.findBranchById(fineData.branchId);

      if (!findBranch) {
        throw new BranchNotFoundError();
      }

      if (findBranch.businessId !== existingFine.businessId) {
        throw new BranchNotBelongBusinessError();
      }
    }

    if (fineData.driverId) {
      const findDriver = await this.driver.findDriverById(fineData.driverId);

      if (!findDriver) {
        throw new DriverNotFoundError();
      }

      if (findDriver.businessId !== existingFine.businessId) {
        throw new DriverNotBelongBusinessError();
      }
    }

    if (fineData.vehicleId) {
      const findVehicle = await this.vehicle.findVehicleById(
        fineData.vehicleId,
      );

      if (!findVehicle) {
        throw new VehicleNotFoundError();
      }

      if (findVehicle.businessId !== existingFine.businessId) {
        throw new VehicleNotBelongBusinessError();
      }
    }

    let newTrafficViolationCode = null;

    if (fineData.trafficViolationCodeId) {
      newTrafficViolationCode =
        await this.trafficViolationCode.findTrafficViolationCodeById(
          fineData.trafficViolationCodeId,
        );

      if (!newTrafficViolationCode) {
        throw new TrafficViolationCodeNotFoundError();
      }

      if (
        fineData.trafficViolationCodeId !==
          existingFine.trafficViolationCodeId &&
        !fineData.points
      ) {
        fineData.points = newTrafficViolationCode.points;
      }
    }

    if (fineData.violation_date && fineData.due_date) {
      const violationDate = new Date(fineData.violation_date);
      const dueDate = new Date(fineData.due_date);

      if (dueDate <= violationDate) {
        throw new FineDueDateMustBeAfterInfractionError();
      }
    } else if (fineData.violation_date) {
      const violationDate = new Date(fineData.violation_date);
      const existingDueDate = new Date(existingFine.due_date);

      if (existingDueDate <= violationDate) {
        throw new FineDueDateInfractionCannotBeLaterError();
      }
    } else if (fineData.due_date) {
      const dueDate = new Date(fineData.due_date);
      const existingViolationDate = new Date(existingFine.violation_date);

      if (dueDate <= existingViolationDate) {
        throw new FineDueDateMustBeLaterInfractionError();
      }
    }

    if (fineData.payment_date) {
      const paymentDate = new Date(fineData.payment_date);
      const violationDate = new Date(
        fineData.violation_date || existingFine.violation_date,
      );

      if (paymentDate < violationDate) {
        throw new FinePaymentDateCannotBeEarlierInfractionError();
      }
    }

    // 📍 GEOLOCATION LOGIC FOR UPDATE: Process location changes
    // Check if latitude or longitude were explicitly provided (not undefined)
    const hasLatitude = "latitude" in fineData;
    const hasLongitude = "longitude" in fineData;

    if (hasLatitude || hasLongitude) {
      // If both latitude and longitude are provided and not null
      if (
        fineData.latitude !== null &&
        fineData.longitude !== null &&
        fineData.latitude &&
        fineData.longitude
      ) {
        fineData.location_source = "USER_MANUAL";
        (fineData as any).location_edited_by = userId;
        (fineData as any).location_edited_at = new Date();
      }
      // If either is null, user is removing the location
      else if (fineData.latitude === null || fineData.longitude === null) {
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
      });

      // Process activity asynchronously without blocking the main flow
      this.notificationService.createActivityIfEnabled({
        type: "Multa",
        action: "update",
        entityId: updatedFine.id,
        description: `Multa atualizada | Valor: ${formatCurrency(Number(updatedFine.amount))} | ID: ${updatedFine.id}`,
        status: "Atualizado",
        performedBy: userId,
        businessId: existingFine.businessId,
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
