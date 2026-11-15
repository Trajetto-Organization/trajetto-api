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
  geocodeSoon,
  unlocatedDeliveryIds,
} from "@/shared/delivery/geocoding/geocode-soon";
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
import { DeliveryStatusConflictError } from "@/modules/delivery/usecases/errors/delivery-errors";

import {
  buildDeliveryCustomerPayload,
  hasSomebodyToTell,
} from "@/shared/delivery/customer-notice";

import type { Prisma } from "@prisma/client";
import type { IStatusChangeReasonRepository } from "@/modules/status-change-reason/repositories/IStatus-change-reason-repository";
import type { OutboxService } from "@/shared/notifications/outbox-service";

import type { RouteStop } from "../../dtos/route-dto";

interface AddRouteStopsRequest {
  userId: string;
  businessId: string;
  routeId: string;
  deliveryIds: string[];

  /** The plan the dispatcher is looking at (decision 14.7, D5). */
  expectedPlanVersion?: number;

  /**
   * "Reentregar" (K12, decision D30): the failed deliveries of the list go
   * back to PENDING with this reason — the one a status change by hand
   * always asks for — and onto the route, in the same transaction. Without
   * it a failed delivery is refused, as before.
   */
  redelivery?: { reasonId: string; note?: string | null };
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
 * Adds deliveries to a route that has not ended, at the end of the order.
 *
 * At the end and not in the middle: where a stop goes is the dispatcher's
 * decision, made by dragging, and guessing an insertion point would be a
 * different guess from the one they are about to make anyway.
 *
 * A running route takes new work too (K12, decision D30): the load goes on
 * the street in the same commit (IN_TRANSIT, as at the departure), the
 * person waiting is told it left, and the driver is told the plan changed —
 * which is what used to make adding to it unsafe. A route that ended
 * (completed or cancelled) refuses.
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
    // K12. Optional so callers built before "Reentregar" and the running
    // route keep working; the container always provides both.
    @inject("StatusChangeReasonRepository")
    private reasons?: IStatusChangeReasonRepository,
    @inject("OutboxService")
    private outbox?: OutboxService,
  ) {}

  async execute({
    userId,
    businessId,
    routeId,
    deliveryIds,
    expectedPlanVersion,
    redelivery,
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

    // "Reentregar": the failed ones go back to PENDING first, in the
    // transaction below, so they are judged as the pending deliveries they
    // will be. The reason is checked like a status change by hand checks it.
    const redelivered = redelivery
      ? deliveries.filter(
          (entry) =>
            entry.businessId === businessId && entry.status === "FAILED",
        )
      : [];

    if (redelivery) await this.assertReason(redelivery.reasonId, businessId);

    assertDeliveriesRoutable(
      deliveries.map((entry) =>
        redelivered.includes(entry) ? { ...entry, status: "PENDING" } : entry,
      ),
      toAdd,
      businessId,
    );

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
        if (redelivered.length > 0) {
          // The route row before the deliveries', the order every writer
          // takes them in (a cancellation: route → stops → deliveries).
          await this.route.lockRoutes([routeId], businessId, tx);

          for (const entry of redelivered) {
            await this.redeliver(entry.id!, userId, redelivery!, tx);
          }
        }

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

        // On a running route these left now: "saiu para entrega", in this
        // commit, as the departure tells its own load (K12).
        if (result.status === "IN_PROGRESS") {
          for (const delivery of deliveries) {
            if (!hasSomebodyToTell(delivery)) continue;

            await this.outbox?.publish(tx, {
              topic: "delivery.dispatched",
              aggregateType: "delivery",
              aggregateId: delivery.id!,
              businessId,
              actorId: userId,
              payload: buildDeliveryCustomerPayload(delivery.id!, {
                ...delivery,
                businessId,
              }),
            });
          }
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
        actorId: userId,
      });

      // The new stops' address points now rather than at the next minute's
      // job (E1), which still takes the open stops first when this one
      // could not ask. Never awaited.
      geocodeSoon(businessId, unlocatedDeliveryIds(deliveries));

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

      // Raised when the route ended (completed or cancelled) before the
      // write — the same empty result set the tenant produces.
      if (error instanceof RouteStatusConflictError) {
        throw new AppError(
          "Esta rota já foi concluída ou cancelada e não aceita novas paradas. Atualize a tela.",
          409,
          "ROUTE_STATUS_CONFLICT",
        );
      }

      // A failed delivery that moved (another screen) between the read and
      // the redelivery: nothing was written.
      if (error instanceof DeliveryStatusConflictError) {
        throw new AppError(error.message, 409, "DELIVERY_STATUS_CONFLICT");
      }

      if (error instanceof AppError) throw error;

      throw new AppError(
        "Houve um erro ao tentar adicionar paradas à rota! Por favor, tente novamente.",
        500,
      );
    }
  }

  /**
   * The reason of a "Reentregar", checked like a status change by hand
   * checks it: of this company (another one's reads as missing) and active.
   */
  private async assertReason(
    reasonId: string,
    businessId: string,
  ): Promise<void> {
    const found = await this.reasons?.findStatusChangeReasonById(reasonId);

    if (!found || found.businessId !== businessId) {
      throw new AppError(
        "Motivo não encontrado.",
        404,
        "STATUS_CHANGE_REASON_NOT_FOUND",
      );
    }

    if (found.is_active === false) {
      throw new AppError(
        "Este motivo está desativado e não pode ser usado em novas mudanças de status.",
        400,
        "STATUS_CHANGE_REASON_INACTIVE",
      );
    }
  }

  /**
   * FAILED → PENDING, the redelivery decision (delivery-rules), with the
   * trail's STATUS_CHANGE line citing the reason — the same two writes a
   * status change by hand makes, inside the caller's transaction. Only from
   * FAILED: a delivery that moved since answers DELIVERY_STATUS_CONFLICT.
   */
  private async redeliver(
    deliveryId: string,
    userId: string,
    redelivery: { reasonId: string; note?: string | null },
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await this.delivery.updateDeliveryStatus(
      deliveryId,
      {
        status: "PENDING",
        expectedStatus: "FAILED",
        delivered_at: null,
        received_by: null,
      },
      tx,
    );

    await this.delivery.createDeliveryEvent(
      {
        type: "STATUS_CHANGE",
        deliveryId,
        reportedById: userId,
        actor: "USER",
        status_from: "FAILED",
        status_to: "PENDING",
        reasonId: redelivery.reasonId,
        note: redelivery.note?.trim() || null,
      },
      tx,
    );
  }
}

export { AddRouteStopsUseCase };
export type { AddRouteStopsRequest, AddRouteStopsResult };
