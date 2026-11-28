import { inject, injectable } from "tsyringe";

import { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { NotificationService } from "@/shared/services/notification-service";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { VehicleNotBelongBusinessError } from "../errors/vehicle-not-belong-business-error";
import { VehicleNotFoundError } from "../errors/vehicle-not-found-error";

import { VehicleHasAssociatedServiceOrdersError } from "../errors/vehicle-has-associated-service-orders-error";
import { VehicleHasAssociatedFinesError } from "../errors/vehicle-has-associated-fines-error";
import { VehicleHasAssociatedFuelError } from "../errors/vehicle-has-associated-fuel-error";

import { VehicleHasAssociatedChecklistsError } from "../errors/vehicle-has-associated-checklists-error";
import { VehicleHasAssociatedPayablesError } from "../errors/vehicle-has-associated-payables-error";

import { IDeliveryRepository } from "@/modules/delivery/repositories/IDelivery-repository";
import { IRouteRepository } from "@/modules/route/repositories/IRoute-repository";

import { VehicleHasAssociatedOperationError } from "../errors/vehicle-has-associated-operation-error";

import { AppError } from "@/shared/errors/AppError";
import { conflictFromPrisma } from "@/shared/errors/prisma-conflict";
import { Vehicle } from "../../dtos/vehicle-dto";
import { sendCatalogChangedEvent } from "@/websocket";

@injectable()
class DeleteVehicleUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("VehicleRepository")
    private vehicle: IVehicleRepository,
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

    // The caller's own company, not only the route guard: a job or another
    // use case reaches this without the HTTP tenant check.
    assertTenantAccess(findUser, businessId);

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

    const refusal = await this.usageRefusal(vehicleId);

    if (refusal) throw refusal;

    let deletedVehicle: Vehicle;

    try {
      deletedVehicle = await this.vehicle.deleteVehicle(vehicleId);
    } catch (error) {
      // A fine, fueling, order or checklist written between the count and
      // the delete met its RESTRICT key: counted again, the same 409 as the
      // count, never a 500.
      throw (
        (await conflictFromPrisma(error, {
          inUse: () => this.usageRefusal(vehicleId),
        })) ??
        new AppError(
          "Houve um erro ao tentar excluir o veículo! Por favor, tente novamente.",
          500,
        )
      );
    }

    sendCatalogChangedEvent(businessId, "vehicle");

    this.notificationService.createActivityIfEnabled({
      type: "Veículo",
      action: "delete",
      entityId: vehicleId,
      description: `Veículo ${deletedVehicle.license_plate} deletado permanentemente | ID: ${deletedVehicle.id}`,
      status: "Deletado",
      performedBy: userId,
      businessId,
    });

    return deletedVehicle;
  }

  /** What keeps the vehicle from being deleted, the first reason found, or null. */
  private async usageRefusal(vehicleId: string): Promise<Error | null> {
    // Counted in one statement (FLEET-VEH-10): the guards used to load
    // every fine, fuelling, order and checklist of the truck to read
    // `.length` — thousands of rows to answer "is there any".
    const usage = await this.vehicle.countVehicleUsage(vehicleId);

    if (usage.fines > 0) {
      return new VehicleHasAssociatedFinesError(usage.fines);
    }

    if (usage.serviceOrders > 0) {
      return new VehicleHasAssociatedServiceOrdersError(usage.serviceOrders);
    }

    if (usage.fuels > 0) {
      return new VehicleHasAssociatedFuelError(usage.fuels);
    }

    if (usage.checklists > 0) {
      return new VehicleHasAssociatedChecklistsError(usage.checklists);
    }

    if (usage.accountsPayable > 0) {
      return new VehicleHasAssociatedPayablesError(usage.accountsPayable);
    }

    /**
     * The operation history, which the guards above never covered.
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
      return new VehicleHasAssociatedOperationError(
        associatedDeliveries,
        associatedRoutes,
      );
    }

    return null;
  }
}

export { DeleteVehicleUseCase };
