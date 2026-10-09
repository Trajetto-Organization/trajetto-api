import { inject, injectable } from "tsyringe";
import { Prisma } from "@prisma/client";

import { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IFineRepository } from "@/modules/fine/repositories/IFine-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { IDeliveryRepository } from "@/modules/delivery/repositories/IDelivery-repository";
import { IRouteRepository } from "@/modules/route/repositories/IRoute-repository";

import { AppError } from "@/shared/errors/AppError";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { DriverNotBelongBusinessError } from "../errors/driver-not-belong-business-error";
import { DriverNotFoundError } from "../errors/driver-not-found-error";

import { NotificationService } from "@/shared/services/notification-service";

import {
  driverHistoryRefusal,
  type DriverHistoryCounts,
} from "../errors/driver-history-refusal";

import { IFuelRepository } from "@/modules/fuel/repositories/IFuel-repository";
import { IVehicleChecklistRepository } from "@/modules/vehicle-checklist/repositories/IVehicle-checklist-repository";

import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";
import { sendCatalogChangedEvent } from "@/websocket";

import { Driver } from "../../dtos/driver-dto";

@injectable()
class DeleteDriverUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("DriverRepository")
    private driver: IDriverRepository,
    @inject("FineRepository")
    private fine: IFineRepository,
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
    driverId: string,
    userId: string,
    businessId: string,
  ): Promise<Driver> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    assertTenantAccess(findUser, businessId);

    const findBusiness = await this.business.findBusinessById(businessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    const findDriverById = await this.driver.findDriverById(driverId);

    if (!findDriverById) {
      throw new DriverNotFoundError();
    }

    if (findDriverById.businessId !== businessId) {
      throw new DriverNotBelongBusinessError();
    }

    /**
     * The history that keeps a driver from being deleted, counted (never
     * loaded) and refused with the first reason found. Deliveries and routes
     * matter as much as fines: `Delivery.driver` is optional, so without the
     * guard a DELIVERED delivery would lose who delivered it
     * (tests/E2E/delete-cascade-integrity). The repository counts all of it
     * again under the driver row's lock before the DELETE.
     */
    const refusal = driverHistoryRefusal(await this.historyOf(driverId));

    if (refusal) throw refusal;

    let driverDeleted: Driver;

    try {
      driverDeleted = await this.driver.deleteDriver(driverId);
    } catch (error) {
      // The history refusal from under the lock: the same 409 as above.
      if (error instanceof AppError) throw error;

      // Deleted by someone else since it was read.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2025"
      ) {
        throw new DriverNotFoundError();
      }

      throw new AppError(
        "Houve um erro ao tentar deletar o motorista! Por favor, tente novamente.",
        500,
      );
    }

    sendCatalogChangedEvent(businessId, "driver");

    // Process activity asynchronously without blocking the main flow
    this.notificationService.createActivityIfEnabled({
      type: "Motorista",
      action: "delete",
      entityId: driverDeleted.id,
      description: `Motorista excluído: ${driverDeleted.name} | CNH: ${driverDeleted.cnh} | ID: ${driverDeleted.id}`,
      status: "Deletado",
      performedBy: userId,
      businessId: businessId,
    });

    return driverDeleted;
  }

  /** Sequential: a delete is rare, and the pool budget is per request. */
  private async historyOf(driverId: string): Promise<DriverHistoryCounts> {
    const users = (await this.user.findUserByDriverId(driverId)) ? 1 : 0;
    const fines = await this.fine.countFinesByDriverId(driverId);
    const fuels = await this.fuel.countFuelsByDriverId(driverId);
    const checklists =
      await this.vehicleChecklist.countVehicleChecklistsByDriverId(driverId);
    const deliveries = await this.delivery.countDeliveriesReferencing({ driverId });
    const routes = await this.route.countRoutesReferencing({ driverId });
    // `driver_pause.driverId` is RESTRICT: without this the database refused
    // and the refusal surfaced as a 500.
    const pauses = await this.driver.countDriverPauses(driverId);

    return { users, fines, fuels, checklists, deliveries, routes, pauses };
  }
}

export { DeleteDriverUseCase };
