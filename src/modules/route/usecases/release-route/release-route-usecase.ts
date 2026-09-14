import { inject, injectable } from "tsyringe";

import { IRouteRepository } from "../../repositories/IRoute-repository";
import { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";

import { NotificationService } from "@/shared/services/notification-service";
import { AppError } from "@/shared/errors/AppError";

import {
  canReleaseRoute,
  canTransitionRoute,
  canUnreleaseRoute,
} from "@/shared/route/route-rules";

import {
  RouteNotBelongBusinessError,
  RouteNotFoundError,
  RouteStatusConflictError,
} from "../errors/route-errors";

import type { Route } from "../../dtos/route-dto";

interface ReleaseRouteRequest {
  userId: string;
  businessId: string;
  routeId: string;

  /** false pulls a released route back to planning, for editing. */
  released?: boolean;
}

/**
 * Hands a route to its driver, or pulls it back.
 *
 * Releasing is the moment the route stops being a draft: from here the driver
 * sees it in the app and can leave with it. That is why the vehicle is
 * required one step earlier than the departure strictly needs it — discovering
 * at the truck that no vehicle was assigned costs a phone call and a morning.
 */
@injectable()
class ReleaseRouteUseCase {
  constructor(
    @inject("RouteRepository")
    private route: IRouteRepository,
    @inject("DriverRepository")
    private driver: IDriverRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute({
    userId,
    businessId,
    routeId,
    released = true,
  }: ReleaseRouteRequest): Promise<Route> {
    const findRoute = await this.route.findRouteById(routeId);

    if (!findRoute) throw new AppError(new RouteNotFoundError().message, 404);

    if (findRoute.businessId !== businessId) {
      throw new AppError(
        new RouteNotBelongBusinessError().message,
        403,
        "ROUTE_NOT_BELONG_BUSINESS",
      );
    }

    const target = released ? "RELEASED" : "PLANNED";

    const verdict = canTransitionRoute(findRoute.status, target);

    if (!verdict.allowed) {
      throw new AppError(verdict.reason!, 400, "INVALID_ROUTE_TRANSITION");
    }

    if (released) {
      const findDriver = await this.driver.findDriverById(findRoute.driverId);

      const readiness = canReleaseRoute({
        stopCount: findRoute.stops.length,
        hasVehicle: Boolean(findRoute.vehicleId),
        isDriverActive: findDriver?.status === "ACTIVE",
      });

      if (!readiness.allowed) {
        throw new AppError(readiness.reason!, 400, "ROUTE_NOT_RELEASABLE");
      }
    } else {
      // Pulling back is only legal while nothing was executed. Once a stop has
      // been worked, the route is a record of what the driver did, and editing
      // it would rewrite that.
      const reversible = canUnreleaseRoute(
        findRoute.stops.map((stop) => stop.status),
      );

      if (!reversible.allowed) {
        throw new AppError(reversible.reason!, 400, "ROUTE_ALREADY_STARTED");
      }
    }

    try {
      const updated = await this.route.transitionRoute(routeId, {
        expectedStatus: findRoute.status,
        status: target,
      });

      this.notificationService.createActivityIfEnabled({
        type: "Rota",
        action: "update",
        entityId: routeId,
        description: released
          ? `Rota ${findRoute.code} liberada para o motorista`
          : `Rota ${findRoute.code} devolvida ao planejamento`,
        status: released ? "Liberada" : "Planejada",
        performedBy: userId,
        businessId,
      });

      return updated;
    } catch (error) {
      if (error instanceof RouteStatusConflictError) {
        throw new AppError(error.message, 409, "ROUTE_STATUS_CONFLICT");
      }

      if (error instanceof AppError) throw error;

      throw new AppError(
        "Houve um erro ao tentar liberar a rota! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { ReleaseRouteUseCase };
export type { ReleaseRouteRequest };
