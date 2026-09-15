import { inject, injectable } from "tsyringe";

import { IRouteRepository } from "../../repositories/IRoute-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";
import { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";

import { assertRouteDispatcher } from "../shared/assert-route-dispatcher";

import { NotificationService } from "@/shared/services/notification-service";
import { AppError } from "@/shared/errors/AppError";

import { isVehicleOutOfOperation } from "@/shared/vehicle/vehicle-rules";

import {
  RouteDriverInactiveError,
  RouteNotFoundError,
  RouteStatusConflictError,
  RouteVehicleUnavailableError,
} from "../errors/route-errors";

import type { Route } from "../../dtos/route-dto";

interface UpdateRouteRequest {
  userId: string;
  businessId: string;
  routeId: string;

  name?: string | null;
  scheduled_date?: Date;

  planned_departure_at?: Date | null;
  planned_arrival_at?: Date | null;

  driverId?: string;
  vehicleId?: string | null;
}

/** Only a route that has not been executed may be edited. */
const EDITABLE = new Set(["PLANNED", "RELEASED"]);

/**
 * Edits the plan: name, day, windows, driver, vehicle.
 *
 * Not a status change — those go through release / start / cancel. What this
 * shares with them is the discipline: the tenant and the state are checked
 * here for a good error message, and carried into the `where` so the write
 * itself cannot land on a route of another company or on one that has already
 * run.
 *
 * Changing the driver or the vehicle also moves the shadow on the deliveries,
 * which is why that happens inside the repository rather than here: those
 * columns have exactly one writer.
 */
@injectable()
class UpdateRouteUseCase {
  constructor(
    @inject("RouteRepository")
    private route: IRouteRepository,
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("DriverRepository")
    private driver: IDriverRepository,
    @inject("VehicleRepository")
    private vehicle: IVehicleRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute({
    userId,
    businessId,
    routeId,
    driverId,
    vehicleId,
    ...fields
  }: UpdateRouteRequest): Promise<Route> {
    // Planning is the dispatcher's job, and `delivery_manage` is open to
    // drivers so the app's own surface works — so the permission says yes
    // and this says no.
    await assertRouteDispatcher(this.user, userId);

    const findRoute = await this.route.findRouteById(routeId, businessId);

    // Scoped read: another company's route reads as absent.
    if (!findRoute) throw new AppError(new RouteNotFoundError().message, 404);

    if (!EDITABLE.has(findRoute.status)) {
      throw new AppError(
        "Esta rota já foi executada e não pode mais ser editada. " +
          "Cancele-a se precisar refazê-la.",
        400,
        "ROUTE_NOT_EDITABLE",
      );
    }

    if (driverId && driverId !== findRoute.driverId) {
      const findDriver = await this.driver.findDriverById(driverId);

      if (!findDriver || findDriver.businessId !== businessId) {
        throw new AppError("Motorista não encontrado.", 404, "DRIVER_NOT_FOUND");
      }

      if (findDriver.status !== "ACTIVE") {
        throw new AppError(
          new RouteDriverInactiveError().message,
          400,
          "ROUTE_DRIVER_INACTIVE",
        );
      }
    }

    if (vehicleId) {
      const findVehicle = await this.vehicle.findVehicleById(vehicleId);

      if (!findVehicle || findVehicle.businessId !== businessId) {
        throw new AppError("Veículo não encontrado.", 404, "VEHICLE_NOT_FOUND");
      }

      if (isVehicleOutOfOperation(findVehicle.status)) {
        throw new AppError(
          new RouteVehicleUnavailableError().message,
          400,
          "ROUTE_VEHICLE_UNAVAILABLE",
        );
      }
    }

    try {
      const updated = await this.route.updateRoute(routeId, businessId, {
        ...fields,
        ...(driverId !== undefined && { driverId }),
        ...(vehicleId !== undefined && { vehicleId }),
      });

      this.notificationService.createActivityIfEnabled({
        type: "Rota",
        action: "update",
        entityId: routeId,
        description: `Rota ${findRoute.code} editada`,
        status: updated.status,
        performedBy: userId,
        businessId,
      });

      return updated;
    } catch (error) {
      // The route moved between the read and the write — released, started or
      // cancelled by somebody else while this form was open.
      if (error instanceof RouteStatusConflictError) {
        throw new AppError(error.message, 409, "ROUTE_STATUS_CONFLICT");
      }

      if (error instanceof AppError) throw error;

      throw new AppError(
        "Houve um erro ao tentar editar a rota! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { UpdateRouteUseCase };
export type { UpdateRouteRequest };
