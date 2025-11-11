import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";
import { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";

import { IVehicleAssignmentRepository } from "../../repositories/IVehicleAssignment-repository";
import { NotificationService } from "@/shared/services/notification-service";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";
import { DriverNotFoundError } from "@/modules/driver/usecases/errors/driver-not-found-error";

import { VehicleAssignmentNotFoundError } from "../errors/vehicle-assignment-not-found-error";

import {
  UpdateVehicleAssignmentProps,
  VehicleAssignment,
} from "../../dtos/vehicle-assignment-dto";
import { AppError } from "@/shared/errors/AppError";

@injectable()
class UpdateAssignmentUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("VehicleRepository")
    private vehicle: IVehicleRepository,
    @inject("DriverRepository")
    private driver: IDriverRepository,
    @inject("VehicleAssignmentRepository")
    private vehicleAssignment: IVehicleAssignmentRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute(
    data: UpdateVehicleAssignmentProps & { businessId: string },
    userId: string,
  ): Promise<VehicleAssignment> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findBusiness = await this.business.findBusinessById(data.businessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    if (findUser.role !== "MASTER") {
      if (findUser.businessId !== data.businessId) {
        throw new AppError("Sem permissão para acessar esta empresa!", 403);
      }
    }

    const existingAssignment =
      await this.vehicleAssignment.findAssignmentByBusinessAndId(
        data.id,
        data.businessId,
      );

    if (!existingAssignment) {
      throw new VehicleAssignmentNotFoundError();
    }

    if (data.vehicleId) {
      const findVehicle = await this.vehicle.findVehicleById(data.vehicleId);

      if (!findVehicle) {
        throw new VehicleNotFoundError();
      }

      if (findVehicle.businessId !== data.businessId) {
        throw new AppError("Veículo não pertence a esta empresa!", 403);
      }
    }

    if (data.driverId) {
      const findDriver = await this.driver.findDriverById(data.driverId);

      if (!findDriver) {
        throw new DriverNotFoundError();
      }

      if (findDriver.businessId !== data.businessId) {
        throw new AppError("Motorista não pertence a esta empresa!", 403);
      }
    }

    const assignment = await this.vehicleAssignment.updateAssignment(data);

    this.notificationService.createActivityIfEnabled({
      type: "VehicleAssignment",
      action: "update",
      entityId: assignment.id,
      description: `Atribuição atualizada | ${assignment.id}`,
      status: "active",
      performedBy: userId,
      businessId: data.businessId,
    });

    return assignment;
  }
}

export { UpdateAssignmentUseCase };
