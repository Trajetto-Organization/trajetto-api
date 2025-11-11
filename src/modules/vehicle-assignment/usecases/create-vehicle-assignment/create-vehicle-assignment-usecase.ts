import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";
import { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";

import { IRouteRepository } from "@/modules/routing/repositories/IRoute-repository";
import { IVehicleAssignmentRepository } from "../../repositories/IVehicleAssignment-repository";

import { NotificationService } from "@/shared/services/notification-service";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";
import { DriverNotFoundError } from "@/modules/driver/usecases/errors/driver-not-found-error";

import { RouteNotFoundError } from "@/modules/routing/usecases/errors/route-not-found-error";
import { VehicleAlreadyAssignedError } from "../errors/vehicle-already-assigned-error";

import {
  CreateVehicleAssignmentProps,
  VehicleAssignment,
} from "../../dtos/vehicle-assignment-dto";
import { AppError } from "@/shared/errors/AppError";

@injectable()
class CreateVehicleAssignmentUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("VehicleRepository")
    private vehicle: IVehicleRepository,
    @inject("DriverRepository")
    private driver: IDriverRepository,
    @inject("RouteRepository")
    private route: IRouteRepository,
    @inject("VehicleAssignmentRepository")
    private vehicleAssignment: IVehicleAssignmentRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute(
    data: CreateVehicleAssignmentProps,
    userId: string,
  ): Promise<VehicleAssignment> {
    // Validate user exists
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    // Validate business exists
    const findBusiness = await this.business.findBusinessById(data.businessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    // Validate permission (multi-tenancy)
    if (findUser.role !== "MASTER") {
      if (findUser.businessId !== data.businessId) {
        throw new AppError("Sem permissão para acessar esta empresa!", 403);
      }
    }

    // Validate route exists and belongs to business
    const findRoute = await this.route.findRouteByBusinessAndId(
      data.routeId,
      data.businessId,
    );

    if (!findRoute) {
      throw new RouteNotFoundError();
    }

    // Validate vehicle exists and belongs to business
    const findVehicle = await this.vehicle.findVehicleById(data.vehicleId);

    if (!findVehicle) {
      throw new VehicleNotFoundError();
    }

    if (findVehicle.businessId !== data.businessId) {
      throw new AppError("Veículo não pertence a esta empresa!", 403);
    }

    // Validate driver (if provided) exists and belongs to business
    if (data.driverId) {
      const findDriver = await this.driver.findDriverById(data.driverId);

      if (!findDriver) {
        throw new DriverNotFoundError();
      }

      if (findDriver.businessId !== data.businessId) {
        throw new AppError("Motorista não pertence a esta empresa!", 403);
      }
    }

    // Check if vehicle is already assigned for this date
    const existingAssignment =
      await this.vehicleAssignment.findByVehicleAndDate(
        data.vehicleId,
        new Date(data.scheduledDate),
      );

    if (existingAssignment) {
      throw new VehicleAlreadyAssignedError();
    }

    // Create assignment
    const assignment = await this.vehicleAssignment.createAssignment(data);

    // Create activity log
    this.notificationService.createActivityIfEnabled({
      type: "VehicleAssignment",
      action: "create",
      entityId: assignment.id,
      description: `Atribuição criada | Veículo ${findVehicle.license_plate} para rota ${findRoute.name || findRoute.id}`,
      status: "active",
      performedBy: userId,
      businessId: data.businessId,
    });

    return assignment;
  }
}

export { CreateVehicleAssignmentUseCase };
