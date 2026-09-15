import { inject, injectable } from "tsyringe";

import { IRouteRepository } from "../../repositories/IRoute-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import database from "@/../infra/database";
import { OutboxService } from "@/shared/notifications/outbox-service";

import { assertRouteDispatcher } from "../shared/assert-route-dispatcher";

import { NotificationService } from "@/shared/services/notification-service";
import { AppError } from "@/shared/errors/AppError";

import { canTransitionRoute } from "@/shared/route/route-rules";

import {
  RouteNotFoundError,
  RouteStatusConflictError,
} from "../errors/route-errors";

import type { Route } from "../../dtos/route-dto";

interface CancelRouteRequest {
  userId: string;
  businessId: string;
  routeId: string;
  reason: string;
}

/**
 * Cancels a route and releases everything it was holding.
 *
 * The reason is required, and not as ceremony: cancelling a route that already
 * left throws away a driver's morning, and the only way anyone reconstructs
 * why is if the person who did it said so at the time.
 *
 * Cancelling also cancels the route's open stops, which is what frees their
 * deliveries under the partial unique index — a delivery whose stop stayed
 * PENDING on a cancelled route would be stuck out of every future route,
 * invisibly. Stops already resolved keep their outcome: a delivery proven this
 * morning was proven, whatever happened to the route afterwards.
 */
@injectable()
class CancelRouteUseCase {
  constructor(
    @inject("RouteRepository")
    private route: IRouteRepository,
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
    @inject("OutboxService")
    private outbox: OutboxService,
  ) {}

  async execute({
    userId,
    businessId,
    routeId,
    reason,
  }: CancelRouteRequest): Promise<Route> {
    // Planning is the dispatcher's job, and `delivery_manage` is open to
    // drivers so the app's own surface works — so the permission says yes
    // and this says no.
    await assertRouteDispatcher(this.user, userId);

    const trimmedReason = reason?.trim();

    if (!trimmedReason) {
      throw new AppError(
        "Informe o motivo do cancelamento da rota.",
        400,
        "ROUTE_CANCELLATION_REASON_REQUIRED",
      );
    }

    const findRoute = await this.route.findRouteById(routeId, businessId);

    // Scoped read: another company's route reads as absent, so there is no
    // separate "not yours" answer to learn from.
    if (!findRoute) throw new AppError(new RouteNotFoundError().message, 404);

    const verdict = canTransitionRoute(findRoute.status, "CANCELLED");

    if (!verdict.allowed) {
      throw new AppError(verdict.reason!, 400, "INVALID_ROUTE_TRANSITION");
    }

    try {
      const cancelled = await database.$transaction(async (tx) => {
        const moved = await this.route.transitionRoute(
          routeId,
          businessId,
          {
            expectedStatus: findRoute.status,
            status: "CANCELLED",
            cancellation_reason: trimmedReason,
          },
          tx,
        );

        // A route still in planning was never handed over, so cancelling it
        // tells nobody anything — the driver never knew it existed. Once
        // released, and especially once it left, the driver has to hear it:
        // they may be standing at an address that was just called off.
        if (findRoute.status !== "PLANNED") {
          const driverUser = await this.user.findUserByDriverId(
            findRoute.driverId,
          );

          await this.outbox.publish(tx, {
            topic: "route.cancelled",
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
              reason: trimmedReason,
              hadDeparted: findRoute.status === "IN_PROGRESS",
            },
          });
        }

        return moved;
      });

      this.notificationService.createActivityIfEnabled({
        type: "Rota",
        action: "update",
        entityId: routeId,
        description: `Rota ${findRoute.code} cancelada: ${trimmedReason}`,
        status: "Cancelada",
        performedBy: userId,
        businessId,
      });

      return cancelled;
    } catch (error) {
      if (error instanceof RouteStatusConflictError) {
        throw new AppError(error.message, 409, "ROUTE_STATUS_CONFLICT");
      }

      if (error instanceof AppError) throw error;

      throw new AppError(
        "Houve um erro ao tentar cancelar a rota! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { CancelRouteUseCase };
export type { CancelRouteRequest };
