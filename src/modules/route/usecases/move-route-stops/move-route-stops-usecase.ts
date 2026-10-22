import { inject, injectable } from "tsyringe";

import { IRouteRepository } from "../../repositories/IRoute-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IDeliveryRepository } from "@/modules/delivery/repositories/IDelivery-repository";

import database from "@/../infra/database";

import { assertRouteDispatcher } from "../shared/assert-route-dispatcher";
import { assertDeliveriesRoutable } from "../shared/routable-deliveries";
import {
  announcePlanChange,
  planWriteFailure,
} from "../shared/route-plan-change";
import { routeWriteFailure } from "../create-route/create-route-usecase";
import { CancelRouteUseCase } from "../cancel-route/cancel-route-usecase";

import { NotificationService } from "@/shared/services/notification-service";
import { AppError } from "@/shared/errors/AppError";
import { ROUTE_STATUS_LABELS } from "@/shared/route/route-rules";

import { WebhookFanOutService } from "@/shared/integration/webhook-fan-out-service";
import { deliveryAssignedPayload } from "@/shared/integration/announce";

import {
  RouteNotFoundError,
  RouteStatusConflictError,
} from "../errors/route-errors";

import type { PlanBump, RouteStop } from "../../dtos/route-dto";

interface MoveRouteStopsRequest {
  userId: string;
  businessId: string;

  /** The route the deliveries go to. */
  routeId: string;
  deliveryIds: string[];

  /** The target's plan the dispatcher is looking at (D5). */
  expectedPlanVersion?: number;
}

interface MoveRouteStopsResult {
  stops: RouteStop[];

  /** The deliveries that left another route for this one. */
  moved: Array<{
    deliveryId: string;
    fromRouteId: string;
    fromRouteCode: number;
  }>;

  /** Ids already open on this route: a retry, not an error. */
  alreadyOnRoute: string[];

  /** Codes of the released routes this left empty, and so cancelled. */
  cancelledRoutes: number[];

  planVersion: number;
}

/**
 * Brings deliveries to this route from wherever they are — another route
 * that has not left, or no route at all — in ONE transaction (decision 14.7,
 * D10).
 *
 * Never "remove there, add here" in two calls: between them another
 * dispatcher takes the delivery. The source routes and the target are locked
 * in id order before anything is read again, so a move A→B and its mirror
 * B→A queue instead of deadlocking. A released source left with nothing is
 * cancelled, with its driver told — the same rule the batch assignment
 * follows; a planned one is a draft and stays.
 */
@injectable()
class MoveRouteStopsUseCase {
  constructor(
    @inject("RouteRepository")
    private route: IRouteRepository,
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("DeliveryRepository")
    private delivery: IDeliveryRepository,
    @inject(CancelRouteUseCase)
    private cancelRoute: CancelRouteUseCase,
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
  }: MoveRouteStopsRequest): Promise<MoveRouteStopsResult> {
    await assertRouteDispatcher(this.user, userId, businessId);

    const target = await this.route.findRouteById(routeId, businessId);

    if (!target) {
      throw new RouteNotFoundError();
    }

    const uniqueIds = [...new Set(deliveryIds)];

    if (uniqueIds.length === 0) {
      throw new AppError(
        "Selecione ao menos uma entrega para mover.",
        400,
        "ROUTE_STOPS_REQUIRED",
      );
    }

    const deliveries = await this.delivery.findDeliveriesByIds(uniqueIds);

    assertDeliveriesRoutable(deliveries, uniqueIds, businessId);

    const labelOf = (id: string) => {
      const found = deliveries.find((entry) => entry.id === id);

      return found?.code ?? found?.recipient_name ?? id;
    };

    const held = await this.route.findOpenStopRoutes(uniqueIds, businessId);

    const alreadyOnRoute = held
      .filter((entry) => entry.routeId === routeId)
      .map((entry) => entry.deliveryId);

    const elsewhere = held.filter((entry) => entry.routeId !== routeId);

    // A load already on the street is the driver's record, not a plan.
    const started = elsewhere.filter(
      (entry) =>
        entry.routeStatus !== "PLANNED" && entry.routeStatus !== "RELEASED",
    );

    if (started.length > 0)
      throw onStartedRoute(started.map((entry) => labelOf(entry.deliveryId)));

    const toAdd = uniqueIds.filter((id) => !alreadyOnRoute.includes(id));

    if (toAdd.length === 0) {
      return {
        stops: [],
        moved: [],
        alreadyOnRoute,
        cancelledRoutes: [],
        planVersion: target.plan_version,
      };
    }

    const movingIds = elsewhere.map((entry) => entry.deliveryId);
    const sourceIds = [...new Set(elsewhere.map((entry) => entry.routeId))];

    try {
      const outcome = await database.$transaction(async (tx) => {
        // Every route this touches, in id order, before any re-read.
        await this.route.lockRoutes([routeId, ...sourceIds], businessId, tx);

        const detached = await this.route.detachFromOpenRoutes(
          movingIds,
          businessId,
          tx,
        );

        // A departure that committed while this waited for the locks.
        if (detached.blocked.length > 0) throw onStartedRoute(detached.blocked);

        const afterCommit: Array<() => Promise<void>> = [];
        const cancelledRoutes: number[] = [];

        for (const emptied of detached.emptiedRoutes) {
          if (emptied.status !== "RELEASED") continue;

          const { afterCommit: cancelled } =
            await this.cancelRoute.cancelWithin(tx, {
              userId,
              businessId,
              route: emptied,
              reason: `Todas as paradas foram movidas para a Rota ${target.code}.`,
            });

          cancelledRoutes.push(emptied.code);
          afterCommit.push(cancelled);
        }

        for (const sourceId of sourceIds) {
          const leaving = elsewhere.filter(
            (entry) => entry.routeId === sourceId,
          );

          await this.route.recordPlanEvents(
            tx,
            leaving.map((entry) => ({
              deliveryId: entry.deliveryId,
              note: `Movida da Rota ${entry.routeCode} para a Rota ${target.code}.`,
            })),
            {
              type: "ROUTE_REMOVED",
              routeId: sourceId,
              businessId,
              actorId: userId,
            },
          );
        }

        // The detach already moved each source's version (D5), once.
        const sources: PlanBump[] = detached.bumped;

        const added = await this.route.addStops(
          routeId,
          businessId,
          toAdd,
          tx,
          {
            expectedPlanVersion,
            actorId: userId,
          },
        );

        // Each document has a new holder: the ERP hears it per delivery, as
        // add-stops and create-route announce it.
        const current =
          (await this.route.findRouteById(routeId, businessId, tx)) ?? target;

        for (const delivery of deliveries) {
          if (!toAdd.includes(delivery.id!)) continue;

          await this.webhooks.announce(
            "delivery.assigned",
            businessId,
            deliveryAssignedPayload({ ...delivery, id: delivery.id! }, current),
            tx,
          );
        }

        return { added, sources, cancelledRoutes, afterCommit };
      });

      for (const run of outcome.afterCommit) await run();

      await announcePlanChange(this.user, {
        businessId,
        routeId,
        routeCode: outcome.added.code,
        planVersion: outcome.added.planVersion,
        status: outcome.added.status,
        driverId: outcome.added.driverId,
      });

      for (const source of outcome.sources) {
        // A cancelled source already told everybody it is gone.
        if (outcome.cancelledRoutes.includes(source.code)) continue;

        await announcePlanChange(this.user, {
          businessId,
          routeId: source.routeId,
          routeCode: source.code,
          planVersion: source.planVersion,
          status: source.status,
          driverId: source.driverId,
        });
      }

      const count = toAdd.length;

      this.notificationService.createActivityIfEnabled({
        type: "Rota",
        action: "update",
        entityId: routeId,
        description:
          `Rota ${target.code}: ${count} entrega${count === 1 ? "" : "s"} ` +
          `adicionada${count === 1 ? "" : "s"}` +
          (movingIds.length > 0
            ? ` (${movingIds.length} movida${movingIds.length === 1 ? "" : "s"} de outra rota)`
            : ""),
        status: ROUTE_STATUS_LABELS[outcome.added.status],
        performedBy: userId,
        businessId,
      });

      return {
        stops: outcome.added.stops,
        moved: elsewhere.map((entry) => ({
          deliveryId: entry.deliveryId,
          fromRouteId: entry.routeId,
          fromRouteCode: entry.routeCode,
        })),
        alreadyOnRoute,
        cancelledRoutes: outcome.cancelledRoutes,
        planVersion: outcome.added.planVersion,
      };
    } catch (error) {
      const planFailure = planWriteFailure(error);

      if (planFailure) throw planFailure;

      if (error instanceof RouteStatusConflictError) {
        throw new AppError(
          "Esta rota já saiu e não aceita novas paradas. Atualize a tela.",
          409,
          "ROUTE_STATUS_CONFLICT",
        );
      }

      throw routeWriteFailure(
        error,
        "Houve um erro ao tentar mover as entregas! Por favor, tente novamente.",
      );
    }
  }
}

function onStartedRoute(blocked: string[]): AppError {
  return new AppError(
    "Estas entregas já estão numa rota que saiu e não podem ser movidas: " +
      blocked.join(", "),
    409,
    "DELIVERY_ON_STARTED_ROUTE",
  );
}

export { MoveRouteStopsUseCase };
export type { MoveRouteStopsRequest, MoveRouteStopsResult };
