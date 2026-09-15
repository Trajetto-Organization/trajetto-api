import { inject, injectable } from "tsyringe";

import { IRouteRepository } from "../../repositories/IRoute-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { assertRouteDispatcher } from "../shared/assert-route-dispatcher";

import { NotificationService } from "@/shared/services/notification-service";
import { AppError } from "@/shared/errors/AppError";

import { RouteNotFoundError, RouteStopNotFoundError } from "../errors/route-errors";

interface RemoveRouteStopRequest {
  userId: string;
  businessId: string;
  routeId: string;
  stopId: string;
}

/**
 * Takes a delivery off a route that has not left, and puts it back in the
 * unassigned pool.
 *
 * Deleted rather than cancelled, and that is the one place in this module
 * where a row disappears: a stop removed while planning never happened. A
 * CANCELLED stop means "the driver was sent here and it was called off",
 * which is a different fact and belongs in the history; a plan that was edited
 * before anyone saw it does not.
 *
 * The delivery keeps its own status — being taken off a route never changed
 * it. Only the driver and vehicle shadow is cleared.
 */
@injectable()
class RemoveRouteStopUseCase {
  constructor(
    @inject("RouteRepository")
    private route: IRouteRepository,
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute({
    userId,
    businessId,
    routeId,
    stopId,
  }: RemoveRouteStopRequest): Promise<void> {
    // Planning is the dispatcher's job, and `delivery_manage` is open to
    // drivers so the app's own surface works — so the permission says yes
    // and this says no.
    await assertRouteDispatcher(this.user, userId);

    const findRoute = await this.route.findRouteById(routeId, businessId);

    if (!findRoute) throw new AppError(new RouteNotFoundError().message, 404);

    try {
      await this.route.removeStop(routeId, businessId, stopId);

      this.notificationService.createActivityIfEnabled({
        type: "Rota",
        action: "update",
        entityId: routeId,
        description: `Rota ${findRoute.code}: parada removida do planejamento`,
        status: findRoute.status,
        performedBy: userId,
        businessId,
      });
    } catch (error) {
      // One answer for "no such stop", "not this route's stop", "not your
      // company's" and "the route already left": the `where` that refuses them
      // is one `where`, and telling the four apart would say more about the
      // data than the caller is entitled to know.
      if (error instanceof RouteStopNotFoundError) {
        throw new AppError(
          "Parada não encontrada nesta rota, ou a rota já saiu e não pode " +
            "mais ser editada.",
          404,
          "ROUTE_STOP_NOT_FOUND",
        );
      }

      if (error instanceof AppError) throw error;

      throw new AppError(
        "Houve um erro ao tentar remover a parada! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { RemoveRouteStopUseCase };
export type { RemoveRouteStopRequest };
