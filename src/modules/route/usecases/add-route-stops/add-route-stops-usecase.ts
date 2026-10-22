import { inject, injectable } from "tsyringe";

import { IRouteRepository } from "../../repositories/IRoute-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IDeliveryRepository } from "@/modules/delivery/repositories/IDelivery-repository";

import database from "@/../infra/database";

import { assertRouteDispatcher } from "../shared/assert-route-dispatcher";

import { NotificationService } from "@/shared/services/notification-service";
import { AppError } from "@/shared/errors/AppError";
import { ROUTE_STATUS_LABELS } from "@/shared/route/route-rules";

import { WebhookFanOutService } from "@/shared/integration/webhook-fan-out-service";
import { deliveryAssignedPayload } from "@/shared/integration/announce";

import { assertDeliveriesRoutable } from "../shared/routable-deliveries";
import {
  alreadyOnRouteMessage,
  announcePlanChange,
  planWriteFailure,
} from "../shared/route-plan-change";

import {
  DeliveryAlreadyOnRouteError,
  DeliveryNoLongerRoutableError,
  RouteNotFoundError,
  RouteStatusConflictError,
} from "../errors/route-errors";

import type { RouteStop } from "../../dtos/route-dto";

interface AddRouteStopsRequest {
  userId: string;
  businessId: string;
  routeId: string;
  deliveryIds: string[];

  /** The plan the dispatcher is looking at (decision 14.7, D5). */
  expectedPlanVersion?: number;
}

interface AddRouteStopsResult {
  stops: RouteStop[];

  /**
   * Ids that were already open stops of THIS route: a retry after a lost
   * answer, answered as success instead of 409.
   */
  alreadyOnRoute: string[];

  planVersion: number;
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
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("DeliveryRepository")
    private delivery: IDeliveryRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
    @inject("WebhookFanOutService")
    private webhooks: WebhookFanOutService,
  ) {}

  async execute({
    userId,
    businessId,
    routeId,
    deliveryIds,
    expectedPlanVersion,
  }: AddRouteStopsRequest): Promise<AddRouteStopsResult> {
    // Planning is the dispatcher's job, and `delivery_manage` is open to
    // drivers so the app's own surface works — so the permission says yes
    // and this says no.
    await assertRouteDispatcher(this.user, userId, businessId);

    const findRoute = await this.route.findRouteById(routeId, businessId);

    // Scoped read: another company's route reads as absent.
    if (!findRoute) throw new RouteNotFoundError();

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

    /**
     * Ids that are already open stops HERE are the first call's own work: a
     * retry after a lost answer. They are skipped and reported, not refused
     * (decision 14.7, §4.3) — the 409 is kept for another route's stop.
     */
    const openHere = new Set(
      findRoute.stops
        .filter(
          (stop) => stop.status === "PENDING" || stop.status === "ARRIVED",
        )
        .map((stop) => stop.deliveryId),
    );

    const alreadyOnRoute = uniqueIds.filter((id) => openHere.has(id));
    const toAdd = uniqueIds.filter((id) => !openHere.has(id));

    if (toAdd.length === 0) {
      return { stops: [], alreadyOnRoute, planVersion: findRoute.plan_version };
    }

    const deliveries = await this.delivery.findDeliveriesByIds(toAdd);

    assertDeliveriesRoutable(deliveries, toAdd, businessId);

    // Named before the write, rather than learned from the unique index
    // after it: the 409 says which delivery is on which route.
    const elsewhere = await this.route.findOpenStopRoutes(toAdd, businessId);

    if (elsewhere.length > 0) {
      const labelOf = (id: string) => {
        const delivery = deliveries.find((entry) => entry.id === id);

        return delivery?.code ?? delivery?.recipient_name ?? id;
      };

      throw new AppError(
        alreadyOnRouteMessage(elsewhere, labelOf),
        409,
        "DELIVERY_ALREADY_ON_ROUTE",
      );
    }

    try {
      /**
       * The stops and their `delivery.assigned` events in one commit.
       *
       * The route already has a driver, so each new stop puts a document in
       * somebody's hands — the fact `delivery.assigned` publishes, which only
       * the route builder used to say. The driver and vehicle are read back
       * inside the transaction, after the write locked the route: a driver
       * swapped between the read above and the lock is the one the stops
       * were given, and the one the ERP must hear about.
       */
      const added = await database.$transaction(async (tx) => {
        const result = await this.route.addStops(
          routeId,
          businessId,
          toAdd,
          tx,
          { expectedPlanVersion, actorId: userId },
        );

        const current =
          (await this.route.findRouteById(routeId, businessId, tx)) ??
          findRoute;

        for (const delivery of deliveries) {
          await this.webhooks.announce(
            "delivery.assigned",
            businessId,
            deliveryAssignedPayload({ ...delivery, id: delivery.id! }, current),
            tx,
          );
        }

        return result;
      });

      await announcePlanChange(this.user, {
        businessId,
        routeId,
        routeCode: added.code,
        planVersion: added.planVersion,
        status: added.status,
        driverId: added.driverId,
      });

      this.notificationService.createActivityIfEnabled({
        type: "Rota",
        action: "update",
        entityId: routeId,
        description:
          `Rota ${findRoute.code}: ${toAdd.length} ` +
          `parada${toAdd.length === 1 ? "" : "s"} adicionada` +
          `${toAdd.length === 1 ? "" : "s"}`,
        // The label, never the enum (the Activities list shows it as stored).
        status: ROUTE_STATUS_LABELS[findRoute.status],
        performedBy: userId,
        businessId,
      });

      return {
        stops: added.stops,
        alreadyOnRoute,
        planVersion: added.planVersion,
      };
    } catch (error) {
      const planFailure = planWriteFailure(error);

      if (planFailure) throw planFailure;

      // 409 and not 400: the request was well formed and the caller was
      // allowed to make it — somebody else put one of these deliveries on a
      // route first. The screen has to say "refresh", not "you did it wrong".
      if (error instanceof DeliveryAlreadyOnRouteError) {
        throw new AppError(error.message, 409, "DELIVERY_ALREADY_ON_ROUTE");
      }

      // A delivery cancelled (or sent out by hand) after the check above:
      // the write refused it and added none of the batch.
      if (error instanceof DeliveryNoLongerRoutableError) {
        throw new AppError(error.message, 409, "DELIVERY_NOT_ROUTABLE");
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
export type { AddRouteStopsRequest, AddRouteStopsResult };
