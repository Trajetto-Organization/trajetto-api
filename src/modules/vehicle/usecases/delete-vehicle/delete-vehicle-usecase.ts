import { inject, injectable } from "tsyringe";

import { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IFineRepository } from "@/modules/fine/repositories/IFine-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { NotificationService } from "@/shared/services/notification-service";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { VehicleNotBelongBusinessError } from "../errors/vehicle-not-belong-business-error";
import { VehicleNotFoundError } from "../errors/vehicle-not-found-error";

import { VehicleHasAssociatedServiceOrdersError } from "../errors/vehicle-has-associated-service-orders-error";
import { IServiceOrderRepository } from "@/modules/service-order/repositories/IService-order-repository";

import { IFuelRepository } from "@/modules/fuel/repositories/IFuel-repository";
import { IVehicleChecklistRepository } from "@/modules/vehicle-checklist/repositories/IVehicle-checklist-repository";

import { VehicleHasAssociatedFinesError } from "../errors/vehicle-has-associated-fines-error";
import { VehicleHasAssociatedFuelError } from "../errors/vehicle-has-associated-fuel-error";

import { VehicleHasAssociatedChecklistsError } from "../errors/vehicle-has-associated-checklists-error";

import { IDeliveryRepository } from "@/modules/delivery/repositories/IDelivery-repository";
import { IRouteRepository } from "@/modules/route/repositories/IRoute-repository";

import { VehicleHasAssociatedOperationError } from "../errors/vehicle-has-associated-operation-error";

import { AppError } from "@/shared/errors/AppError";
import { Vehicle } from "../../dtos/vehicle-dto";

@injectable()
class DeleteVehicleUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("VehicleRepository")
    private vehicle: IVehicleRepository,
    @inject("FineRepository")
    private fine: IFineRepository,
    @inject("ServiceOrderRepository")
    private serviceOrder: IServiceOrderRepository,
    @inject("FuelRepository")
    private fuel: IFuelRepository,
    @inject("VehicleChecklistRepository")
    private vehicleChecklist: IVehicleChecklistRepository,
    @inject("DeliveryRepository")
    private delivery: IDeliveryRepository,
    @inject("RouteRepository")
    private route: IRouteRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute(
    vehicleId: string,
    businessId: string,
    userId: string,
  ): Promise<Vehicle> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findBusiness = await this.business.findBusinessById(businessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    const findVehicle = await this.vehicle.findVehicleById(vehicleId);

    if (!findVehicle) {
      throw new VehicleNotFoundError();
    }

    if (findVehicle.businessId !== businessId) {
      throw new VehicleNotBelongBusinessError();
    }

    const associatedFines = await this.fine.findFinesByVehicleId(vehicleId);

    if (associatedFines.length > 0) {
      throw new VehicleHasAssociatedFinesError(associatedFines.length);
    }

    const associatedServiceOrders =
      await this.serviceOrder.findServiceOrdersByVehicleId(vehicleId);

    if (associatedServiceOrders && associatedServiceOrders.length > 0) {
      throw new VehicleHasAssociatedServiceOrdersError(
        associatedServiceOrders.length,
      );
    }

    const associatedFuels = await this.fuel.findFuelsByVehicleId(vehicleId);

    if (associatedFuels.length > 0) {
      throw new VehicleHasAssociatedFuelError(associatedFuels.length);
    }

    const associatedChecklists =
      await this.vehicleChecklist.findVehicleChecklistsByVehicleId(vehicleId);

    if (associatedChecklists.length > 0) {
      throw new VehicleHasAssociatedChecklistsError(
        associatedChecklists.length,
      );
    }


    /**
     * The operation history, which the four guards above never covered.
     *
     * Both relations are optional, so this delete would SUCCEED and silently
     * erase whose work it was — see tests/E2E/delete-cascade-integrity for
     * what the database actually does without this.
     */
    const [associatedDeliveries, associatedRoutes] = await Promise.all([
      this.delivery.countDeliveriesReferencing({ vehicleId: vehicleId }),
      this.route.countRoutesReferencing({ vehicleId: vehicleId }),
    ]);

    if (associatedDeliveries > 0 || associatedRoutes > 0) {
      throw new VehicleHasAssociatedOperationError(
        associatedDeliveries,
        associatedRoutes,
      );
    }

    try {
      const deletedVehicle = await this.vehicle.deleteVehicle(vehicleId);

      // Process activity asynchronously without blocking the main flow
      this.notificationService.createActivityIfEnabled({
        type: "Veículo",
        action: "delete",
        entityId: vehicleId,
        description: `Veículo ${deletedVehicle.license_plate} deletado permanentemente (sem multas associadas) | ID: ${deletedVehicle.id}`,
        status: "Deletado",
        performedBy: userId,
        businessId,
      });

      return deletedVehicle;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar excluir o veículo! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { DeleteVehicleUseCase };
