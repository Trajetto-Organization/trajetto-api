import { inject, injectable } from "tsyringe";

import { IRouteRepository } from "../../repositories/IRoute-repository";
import { IDeliveryRepository } from "@/modules/delivery/repositories/IDelivery-repository";

import { NotificationService } from "@/shared/services/notification-service";
import { AppError } from "@/shared/errors/AppError";

import { assertDeliveriesRoutable } from "../shared/routable-deliveries";

import {
  DeliveryAlreadyOnRouteError,
  RouteNotFoundError,
  RouteStatusConflictError,
} from "../errors/route-errors";

import type { RouteStop } from "../../dtos/route-dto";

interface AddRouteStopsRequest {
  userId: string;
  businessId: string;
  routeId: string;
  deliveryIds: string[];
}

/**
 * Adds deliveries to a route that has not left yet, at the end of the order.
 *
 * At the end and not in the middle: where a stop goes is the dispatcher's
 * decision, made by dragging, and guessing an insertion point would be a
 * different guess from the one they are about to make anyway.
 *
 * Only a route still in planning accepts new work. Once it has departed, the
 * route is a record of what the driver is doing — adding to it would change a
 * plan the person on the road has already been given, without telling them.
 */
@injectable()
class AddRouteStopsUseCase {
  constructor(
    @inject("RouteRepository")
    private route: IRouteRepository,
    @inject("DeliveryRepository")
    private delivery: IDeliveryRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute({
    userId,
    businessId,
    routeId,
    deliveryIds,
  }: AddRouteStopsRequest): Promise<RouteStop[]> {
    const findRoute = await this.route.findRouteById(routeId, businessId);

    // Scoped read: another company's route reads as absent.
    if (!findRoute) throw new AppError(new RouteNotFoundError().message, 404);

    // Duplicates in a selection are harmless; collapsing them keeps the count
    // checks below honest.
    const uniqueIds = [...new Set(deliveryIds)];

    if (uniqueIds.length === 0) {
      throw new AppError(
        "Selecione ao menos uma entrega para adicionar à rota.",
        400,
        "ROUTE_STOPS_REQUIRED",
      );
    }

    const alreadyHere = new Set(
      findRoute.stops.map((stop) => stop.deliveryId),
    );

    if (uniqueIds.some((id) => alreadyHere.has(id))) {
      throw new AppError(
        "Uma das entregas já está nesta rota. Atualize a tela e tente novamente.",
        409,
        "DELIVERY_ALREADY_ON_ROUTE",
      );
    }

    const deliveries = await this.delivery.findDeliveriesByIds(uniqueIds);

    assertDeliveriesRoutable(deliveries, uniqueIds, businessId);

    try {
      const created = await this.route.addStops(routeId, businessId, uniqueIds);

      this.notificationService.createActivityIfEnabled({
        type: "Rota",
        action: "update",
        entityId: routeId,
        description:
          `Rota ${findRoute.code}: ${uniqueIds.length} ` +
          `parada${uniqueIds.length === 1 ? "" : "s"} adicionada` +
          `${uniqueIds.length === 1 ? "" : "s"}`,
        status: findRoute.status,
        performedBy: userId,
        businessId,
      });

      return created;
    } catch (error) {
      // 409 and not 400: the request was well formed and the caller was
      // allowed to make it — somebody else put one of these deliveries on a
      // route first. The screen has to say "refresh", not "you did it wrong".
      if (error instanceof DeliveryAlreadyOnRouteError) {
        throw new AppError(error.message, 409, "DELIVERY_ALREADY_ON_ROUTE");
      }

      // Raised when the route left, or was cancelled, between the read above
      // and the write — the same empty result set the tenant produces.
      if (error instanceof RouteStatusConflictError) {
        throw new AppError(
          "Esta rota já saiu e não aceita novas paradas. Atualize a tela.",
          409,
          "ROUTE_STATUS_CONFLICT",
        );
      }

      if (error instanceof AppError) throw error;

      throw new AppError(
        "Houve um erro ao tentar adicionar paradas à rota! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { AddRouteStopsUseCase };
export type { AddRouteStopsRequest };
