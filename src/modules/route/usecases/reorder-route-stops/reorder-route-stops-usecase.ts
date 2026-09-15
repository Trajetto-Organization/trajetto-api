import { inject, injectable } from "tsyringe";

import { IRouteRepository } from "../../repositories/IRoute-repository";

import { NotificationService } from "@/shared/services/notification-service";
import { AppError } from "@/shared/errors/AppError";

import {
  RouteNotFoundError,
  RouteReorderMismatchError,
  RouteStatusConflictError,
} from "../errors/route-errors";

interface ReorderRouteStopsRequest {
  userId: string;
  businessId: string;
  routeId: string;

  /** The COMPLETE order, not a move. See the docblock. */
  orderedStopIds: string[];
}

/**
 * Rewrites the order the driver will work the stops in.
 *
 * Takes the complete list rather than "move stop X to position 3", and that is
 * the deliberate choice: a move instruction applied to a route somebody else
 * has edited in the meantime silently produces an order the dispatcher never
 * asked for. The full list cannot — it either describes the route as it is, or
 * it describes a route that no longer exists, and the second is refused.
 *
 * Only a route still in planning can be reordered. Once it departs, the order
 * is what the driver is following on the screen in their hand.
 */
@injectable()
class ReorderRouteStopsUseCase {
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
    orderedStopIds,
  }: ReorderRouteStopsRequest): Promise<void> {
    const findRoute = await this.route.findRouteById(routeId, businessId);

    if (!findRoute) throw new AppError(new RouteNotFoundError().message, 404);

    // Caught here rather than by the repository's set comparison, which would
    // report a duplicate as a mismatch: "você enviou a mesma parada duas
    // vezes" is a different problem from "a rota mudou".
    if (new Set(orderedStopIds).size !== orderedStopIds.length) {
      throw new AppError(
        "A ordem enviada repete a mesma parada. Atualize a tela e refaça a " +
          "ordenação.",
        400,
        "ROUTE_REORDER_DUPLICATE",
      );
    }

    try {
      await this.route.reorderStops(routeId, businessId, orderedStopIds);

      this.notificationService.createActivityIfEnabled({
        type: "Rota",
        action: "update",
        entityId: routeId,
        description: `Rota ${findRoute.code}: ordem das paradas alterada`,
        status: findRoute.status,
        performedBy: userId,
        businessId,
      });
    } catch (error) {
      // The list does not describe this route's current stops: somebody added
      // or removed one while this screen was open. 409, because the request
      // was correct for the route the dispatcher was looking at.
      if (error instanceof RouteReorderMismatchError) {
        throw new AppError(error.message, 409, "ROUTE_REORDER_MISMATCH");
      }

      if (error instanceof RouteStatusConflictError) {
        throw new AppError(
          "Esta rota já saiu e sua ordem não pode mais ser alterada. " +
            "Atualize a tela.",
          409,
          "ROUTE_STATUS_CONFLICT",
        );
      }

      if (error instanceof AppError) throw error;

      throw new AppError(
        "Houve um erro ao tentar reordenar as paradas! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { ReorderRouteStopsUseCase };
export type { ReorderRouteStopsRequest };
