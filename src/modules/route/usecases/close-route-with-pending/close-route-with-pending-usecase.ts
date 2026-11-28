import { inject, injectable } from "tsyringe";

import { IRouteRepository } from "../../repositories/IRoute-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import database from "@/../infra/database";
import { sendRouteEventToBusiness, sendRouteEventToDriver } from "@/websocket";
import { announceRouteVehicle } from "@/shared/vehicle/vehicle-realtime";
import { OutboxService } from "@/shared/notifications/outbox-service";

import { WebhookFanOutService } from "@/shared/integration/webhook-fan-out-service";
import { routeEventPayload } from "@/shared/integration/announce";

import { assertRouteDispatcher } from "../shared/assert-route-dispatcher";

import { NotificationService } from "@/shared/services/notification-service";
import { AppError } from "@/shared/errors/AppError";

import {
  RouteNotFoundError,
  RouteStatusConflictError,
} from "../errors/route-errors";

import type { Route } from "../../dtos/route-dto";

interface CloseRouteWithPendingRequest {
  userId: string;
  businessId: string;
  routeId: string;
  reason: string;

  /** The clock. Only tests pass it. */
  now?: Date;
}

interface CloseRouteWithPendingResult {
  route: Route;

  /** Open stops the close cancelled (their deliveries are Pendente again). */
  cancelledStops: number;

  /**
   * True when the route had already been closed with pending stops: a double
   * click or a resend after a lost answer, answered without writing.
   */
  unchanged: boolean;
}

const statusConflict = () =>
  new AppError(
    "Só uma rota em andamento pode ser encerrada com pendências. Atualize a tela: ela pode ter sido concluída ou cancelada.",
    409,
    "ROUTE_STATUS_CONFLICT",
  );

/**
 * "Encerrar com pendências" (plan of 02/11/2026, K11; decision D26).
 *
 * A route closes itself when its last stop is resolved — and nothing else
 * closed it, so a driver who never resolved the last stop left the route
 * running for days: the driver could not leave on the next one
 * (ROUTE_DRIVER_BUSY), nor could the truck. The dispatcher now closes it,
 * with the reason, which the decision makes mandatory for the same reason
 * a cancellation's is: the trail has to say why.
 *
 * Unlike a cancellation the route ends COMPLETED — what was delivered on it
 * was delivered — with `closure_reason` set. Its open stops are cancelled
 * and their deliveries go back to Pendente with a line saying why (the same
 * release a cancellation does, K8), the driver hears that the plan changed,
 * and the ERP hears `route.completed`.
 */
@injectable()
class CloseRouteWithPendingUseCase {
  constructor(
    @inject("RouteRepository")
    private route: IRouteRepository,
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
    @inject("OutboxService")
    private outbox: OutboxService,
    @inject("WebhookFanOutService")
    private webhooks: WebhookFanOutService,
  ) {}

  async execute({
    userId,
    businessId,
    routeId,
    reason,
    now = new Date(),
  }: CloseRouteWithPendingRequest): Promise<CloseRouteWithPendingResult> {
    // The dispatcher's act: the permission is open to drivers for their own
    // work, so this says no to a driver token whatever the guard said.
    await assertRouteDispatcher(this.user, userId, businessId);

    const trimmedReason = reason?.trim();

    if (!trimmedReason) {
      throw new AppError(
        "Informe o motivo para encerrar a rota com pendências.",
        400,
        "ROUTE_CLOSURE_REASON_REQUIRED",
      );
    }

    // Scoped read: another company's route reads as absent.
    const findRoute = await this.route.findRouteById(routeId, businessId);

    if (!findRoute) throw new RouteNotFoundError();

    // The resend of a close that already happened: nothing to write and
    // nobody to tell again.
    if (findRoute.status === "COMPLETED" && findRoute.closure_reason) {
      return { route: findRoute, cancelledStops: 0, unchanged: true };
    }

    if (findRoute.status !== "IN_PROGRESS") throw statusConflict();

    const driverUser = await this.user.findUserByDriverId(findRoute.driverId);

    let closed: { route: Route; cancelledStops: number };

    try {
      closed = await database.$transaction(async (tx) => {
        const result = await this.route.closeWithPending(
          routeId,
          businessId,
          { reason: trimmedReason, actorId: userId, at: now },
          tx,
        );

        // The driver's push, in the same commit, under the plan version's
        // key like every plan change: one change, one push.
        if (driverUser) {
          await this.outbox.publish(tx, {
            topic: "route.plan_changed",
            aggregateType: "route",
            aggregateId: routeId,
            businessId,
            actorId: userId,
            eventKey: `route:${routeId}:plan:${result.route.plan_version}`,
            payload: {
              routeId,
              businessId,
              driverUserId: driverUser.id,
              code: result.route.code,
              planVersion: result.route.plan_version,
            },
          });
        }

        // The ERP hears the route ended, in the same transaction: an event
        // queued after the commit is one a crash in between erases.
        await this.webhooks.announce(
          "route.completed",
          businessId,
          routeEventPayload(result.route, result.route.completed_at ?? now),
          tx,
        );

        return result;
      });
    } catch (error) {
      // The last stop resolved, or a colleague closed or cancelled it, in
      // the instant between the read and the write.
      if (error instanceof RouteStatusConflictError) throw statusConflict();

      throw error;
    }

    // After the commit: the boards drop the route, the driver's app
    // refetches its plan.
    sendRouteEventToBusiness(businessId, {
      type: "route.completed",
      routeId,
      routeCode: closed.route.code,
    });

    // The truck came back with it.
    announceRouteVehicle(businessId, closed.route);

    sendRouteEventToDriver(driverUser?.id ?? null, {
      type: "route.stops_changed",
      routeId,
      routeCode: closed.route.code,
      planVersion: closed.route.plan_version,
    });

    const stops =
      closed.cancelledStops === 1
        ? "1 parada cancelada"
        : `${closed.cancelledStops} paradas canceladas`;

    this.notificationService.createActivityIfEnabled({
      type: "Rota",
      action: "update",
      entityId: routeId,
      description: `Rota ${closed.route.code} encerrada com pendências (${stops}): ${trimmedReason}`,
      status: "Concluída",
      performedBy: userId,
      businessId,
    });

    return { ...closed, unchanged: false };
  }
}

export { CloseRouteWithPendingUseCase };
export type { CloseRouteWithPendingRequest, CloseRouteWithPendingResult };
