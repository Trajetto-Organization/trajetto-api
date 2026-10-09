import { inject, injectable } from "tsyringe";

import { IRouteRepository } from "../../repositories/IRoute-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { assertRouteDispatcher } from "../shared/assert-route-dispatcher";
import {
  announcePlanChange,
  planWriteFailure,
} from "../shared/route-plan-change";

import { NotificationService } from "@/shared/services/notification-service";
import { AppError } from "@/shared/errors/AppError";
import { ROUTE_STATUS_LABELS } from "@/shared/route/route-rules";

import {
  RouteNotFoundError,
  RouteStatusConflictError,
} from "../errors/route-errors";

import type { PlanStopsRemoved } from "../../dtos/route-dto";

interface RemoveRouteStopsRequest {
  userId: string;
  businessId: string;
  routeId: string;
  stopIds: string[];

  /** The plan the dispatcher is looking at (decision 14.7, D5). */
  expectedPlanVersion?: number;
}

/**
 * Takes several deliveries off a route that has not left, and puts them back
 * in the unassigned pool (decision 14.7, §4.4).
 *
 * Deleted rather than cancelled: a stop removed while planning never
 * happened. The deliveries keep their own status; only the driver and
 * vehicle shadow is cleared, and each one gets a ROUTE_REMOVED line in its
 * timeline.
 *
 * Idempotent: a stop that is not (or no longer) a pending stop of this route
 * comes back in `alreadyGone`, so a retry after a lost answer is harmless.
 * A RELEASED route left empty is NOT cancelled here — the dispatcher is on
 * its screen and is offered "Voltar ao planejamento" or "Cancelar rota".
 */
@injectable()
class RemoveRouteStopsUseCase {
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
    stopIds,
    expectedPlanVersion,
  }: RemoveRouteStopsRequest): Promise<PlanStopsRemoved> {
    // Planning is the dispatcher's job; `delivery_manage` is open to drivers
    // so the app's own surface works — the permission says yes, this says no.
    await assertRouteDispatcher(this.user, userId, businessId);

    const findRoute = await this.route.findRouteById(routeId, businessId);

    // Scoped read: another company's route reads as absent.
    if (!findRoute) {
      throw new RouteNotFoundError();
    }

    try {
      const result = await this.route.removeStops(routeId, businessId, stopIds, {
        expectedPlanVersion,
        actorId: userId,
      });

      if (result.removed.length === 0) return result;

      await announcePlanChange(this.user, {
        businessId,
        routeId,
        routeCode: result.code,
        planVersion: result.planVersion,
        status: result.status,
        driverId: result.driverId,
      });

      const count = result.removed.length;

      this.notificationService.createActivityIfEnabled({
        type: "Rota",
        action: "update",
        entityId: routeId,
        description:
          `Rota ${findRoute.code}: ${count} parada${count === 1 ? "" : "s"} ` +
          `removida${count === 1 ? "" : "s"} do planejamento`,
        // The label, never the enum (the Activities list shows it as stored).
        status: ROUTE_STATUS_LABELS[result.status],
        performedBy: userId,
        businessId,
      });

      return result;
    } catch (error) {
      const planFailure = planWriteFailure(error);

      if (planFailure) throw planFailure;

      // The route left, or was cancelled, between the read and the lock.
      if (error instanceof RouteStatusConflictError) {
        throw new AppError(
          "Esta rota já saiu e não pode mais ser editada. Atualize a tela.",
          409,
          "ROUTE_STATUS_CONFLICT",
        );
      }

      if (error instanceof AppError) throw error;

      throw new AppError(
        "Houve um erro ao tentar remover as paradas! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { RemoveRouteStopsUseCase };
export type { RemoveRouteStopsRequest };
