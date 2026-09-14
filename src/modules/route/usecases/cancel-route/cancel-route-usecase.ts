import { inject, injectable } from "tsyringe";

import { IRouteRepository } from "../../repositories/IRoute-repository";

import { NotificationService } from "@/shared/services/notification-service";
import { AppError } from "@/shared/errors/AppError";

import { canTransitionRoute } from "@/shared/route/route-rules";

import {
  RouteNotBelongBusinessError,
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
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute({
    userId,
    businessId,
    routeId,
    reason,
  }: CancelRouteRequest): Promise<Route> {
    const trimmedReason = reason?.trim();

    if (!trimmedReason) {
      throw new AppError(
        "Informe o motivo do cancelamento da rota.",
        400,
        "ROUTE_CANCELLATION_REASON_REQUIRED",
      );
    }

    const findRoute = await this.route.findRouteById(routeId);

    if (!findRoute) throw new AppError(new RouteNotFoundError().message, 404);

    if (findRoute.businessId !== businessId) {
      throw new AppError(
        new RouteNotBelongBusinessError().message,
        403,
        "ROUTE_NOT_BELONG_BUSINESS",
      );
    }

    const verdict = canTransitionRoute(findRoute.status, "CANCELLED");

    if (!verdict.allowed) {
      throw new AppError(verdict.reason!, 400, "INVALID_ROUTE_TRANSITION");
    }

    try {
      const cancelled = await this.route.transitionRoute(routeId, {
        expectedStatus: findRoute.status,
        status: "CANCELLED",
        cancellation_reason: trimmedReason,
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
