import { inject, injectable } from "tsyringe";

import { IRouteRepository } from "../../repositories/IRoute-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";

import database from "@/../infra/database";
import { OutboxService } from "@/shared/notifications/outbox-service";

import { assertRouteDispatcher } from "../shared/assert-route-dispatcher";

import { NotificationService } from "@/shared/services/notification-service";
import { AppError } from "@/shared/errors/AppError";

import {
  canReleaseRoute,
  canTransitionRoute,
  canUnreleaseRoute,
} from "@/shared/route/route-rules";

import {
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
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("DriverRepository")
    private driver: IDriverRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
    @inject("OutboxService")
    private outbox: OutboxService,
  ) {}

  async execute({
    userId,
    businessId,
    routeId,
    released = true,
  }: ReleaseRouteRequest): Promise<Route> {
    // Planning is the dispatcher's job, and `delivery_manage` is open to
    // drivers so the app's own surface works — so the permission says yes
    // and this says no.
    await assertRouteDispatcher(this.user, userId);

    const findRoute = await this.route.findRouteById(routeId, businessId);

    // The read is already scoped by business, so a route of another company
    // is indistinguishable from one that does not exist — which is the point.
    // A different refusal for "exists but is not yours" tells a caller which
    // ids are real.
    if (!findRoute) throw new AppError(new RouteNotFoundError().message, 404);

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
      // The write and the push land together. Published with the transaction
      // rather than after it, because the event has to exist if and only if
      // the release committed — the alternative is a driver whose phone says
      // the route is theirs over a write that rolled back.
      const updated = await database.$transaction(async (tx) => {
        const moved = await this.route.transitionRoute(
          routeId,
          businessId,
          { expectedStatus: findRoute.status, status: target },
          tx,
        );

        // Only the handover rings. Pulling a route BACK to planning is a
        // correction of something the driver has not started, and a push
        // saying "never mind" about work they had not looked at yet is noise.
        if (released) {
          const driverUser = await this.user.findUserByDriverId(
            findRoute.driverId,
          );

          await this.outbox.publish(tx, {
            topic: "route.released",
            aggregateType: "route",
            aggregateId: routeId,
            businessId,
            actorId: userId,
            payload: {
              routeId,
              businessId,
              driverUserId: driverUser?.id ?? null,
              code: findRoute.code,
              routeName: findRoute.name,
              stopCount: findRoute.stops.length,
              scheduledLabel: findRoute.scheduled_date.toLocaleDateString(
                "pt-BR",
                { day: "2-digit", month: "2-digit" },
              ),
            },
          });
        }

        return moved;
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
