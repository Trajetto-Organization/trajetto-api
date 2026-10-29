import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IDeliveryRepository } from "../../repositories/IDelivery-repository";
import { IRouteRepository } from "@/modules/route/repositories/IRoute-repository";
import { IStatusChangeReasonRepository } from "@/modules/status-change-reason/repositories/IStatus-change-reason-repository";

import database from "@/../infra/database";

import { NotificationService } from "@/shared/services/notification-service";
import {
  DeliveryNotFoundError,
  DeliveryStatusConflictError,
  DeliveryNeedsDriverError,
  DeliveryRouteNotStartedError,
} from "../errors/delivery-errors";

import {
  canTransitionDelivery,
  DeliveryStatus,
  DELIVERY_STATUS_LABELS,
} from "@/shared/delivery/delivery-rules";

import { stopOutcomeForDelivery } from "@/shared/route/route-rules";

import { announceStopSettled } from "@/shared/route/route-realtime";
import { announceDroppedPlans } from "@/modules/route/usecases/shared/route-plan-change";
import type { PlanBump } from "@/modules/route/dtos/route-dto";
import { announceDeliveryOverride } from "@/shared/delivery/delivery-realtime";

import { driverShouldHearOverride } from "@/shared/delivery/driver-worklist";

import {
  buildDeliveryCustomerPayload,
  hasSomebodyToTell,
} from "@/shared/delivery/customer-notice";

import { WebhookFanOutService } from "@/shared/integration/webhook-fan-out-service";
import {
  announceRouteClosed,
  deliveryEventPayload,
} from "@/shared/integration/announce";
import { OutboxService } from "@/shared/notifications/outbox-service";

import { AppError } from "@/shared/errors/AppError";
import { assertDispatcher } from "@/shared/delivery/dispatcher-guard";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";
import { Delivery } from "../../dtos/delivery-dto";

import { callerNotFound } from "@/shared/delivery/caller-not-found";
import { sendDeliveryStatusToBusiness } from "@/websocket";

interface UpdateDeliveryStatusRequest {
  userId: string;
  businessId: string;
  deliveryId: string;
  status: DeliveryStatus;
  received_by?: string;

  /**
   * Why. Required, from the company's own catalogue.
   *
   * This is the one path in the product that moves a delivery by hand rather
   * than because something happened in the field — the driver's app goes
   * through arrival, proof and occurrence, each of which carries its own
   * evidence. An override has none, so the reason IS the evidence, and three
   * days later it is the only thing support has to answer "por que essa está
   * assim?".
   */
  reasonId: string;

  /** The detail the catalogue cannot carry: "cliente ligou às 14h". */
  note?: string | null;
}

@injectable()
class UpdateDeliveryStatusUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("DeliveryRepository")
    private delivery: IDeliveryRepository,
    @inject("RouteRepository")
    private route: IRouteRepository,
    @inject("StatusChangeReasonRepository")
    private reason: IStatusChangeReasonRepository,
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
    deliveryId,
    status,
    received_by,
    reasonId,
    note,
  }: UpdateDeliveryStatusRequest): Promise<Delivery> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw callerNotFound();
    }

    // Defense in depth: the route guard must not be the only wall between
    // tenants (same check as get-delivery and the list/exports).
    assertTenantAccess(findUser, businessId);

    const findDelivery = await this.delivery.findDeliveryById(deliveryId);

    // Another company's id reads as absent (decision 11.3): a separate
    // "not yours" answer told a caller which ids exist elsewhere.
    if (!findDelivery || findDelivery.businessId !== businessId) {
      throw new DeliveryNotFoundError();
    }

    /**
     * The driver does not come through here.
     *
     * `delivery_manage:write` is open to the driver on purpose (the app runs
     * on it), and without this line a driver marked their own delivery
     * DELIVERED through this endpoint: no photo, no signature, no location,
     * going round `register-delivery-proof`, which exists to require the
     * evidence.
     *
     * The old scope ("a driver only moves their own delivery") protected
     * nothing: their own delivery is exactly the one they would close
     * without proving it.
     */
    assertDispatcher(findUser);

    const verdict = canTransitionDelivery(findDelivery.status, status);

    if (!verdict.allowed) {
      throw new AppError(verdict.reason!, 400, "INVALID_STATUS_TRANSITION");
    }

    // "Em rota" from the panel only for a load a driver is carrying on a
    // route that left (decision 5.4). Without a driver the delivery vanished
    // from Monitoring; on a PLANNED/RELEASED route it read "em rota" with its
    // stop open on a route that never started — starting the route is what
    // puts its deliveries on the street.
    const openRoute = await this.delivery.findOpenStopRoute(deliveryId);

    if (status === "IN_TRANSIT") {
      if (!findDelivery.driverId) {
        throw new DeliveryNeedsDriverError();
      }

      if (openRoute?.status === "PLANNED" || openRoute?.status === "RELEASED") {
        throw new DeliveryRouteNotStartedError();
      }
    }

    const findReason = await this.reason.findStatusChangeReasonById(reasonId);

    // Same 404 for "does not exist" and "belongs to another company": a
    // different refusal for the second would tell a caller which ids are real.
    if (!findReason || findReason.businessId !== businessId) {
      throw new AppError(
        "Motivo não encontrado.",
        404,
        "STATUS_CHANGE_REASON_NOT_FOUND",
      );
    }

    // A retired reason keeps explaining the events that already cite it and
    // stops being offered for new ones — which is exactly what deactivating
    // is for, and why the delete is refused once a reason has been used.
    if (findReason.is_active === false) {
      throw new AppError(
        "Este motivo está desativado e não pode ser usado em novas mudanças de status.",
        400,
        "STATUS_CHANGE_REASON_INACTIVE",
      );
    }

    try {
      // Captured to be announced AFTER the commit: a socket event about a
      // write that rolled back is a lie the client cannot undo.
      let settled: Awaited<
        ReturnType<IRouteRepository["settleStopForDelivery"]>
      > = null;

      // What the change means for the stop the delivery occupies. Asked with
      // where it comes FROM: IN_TRANSIT → PENDING is a load returned to base
      // while its route runs, and takes it off that route (IDEMP-11).
      const outcome = stopOutcomeForDelivery(
        status,
        new Date(),
        findDelivery.status,
      );

      // True when this change took the delivery off a running route: the
      // driver loses the address even though PENDING is still "on the list".
      let releasedFromRoute = false;

      // A stop taken off a plan that had not left (its version moved),
      // announced after the commit like every plan write (design §7.1).
      const droppedPlans: PlanBump[] = [];

      // The panel can resolve a delivery the driver never touched — the
      // customer called the office, the load came back. If that delivery is a
      // stop on a running route, the stop has to learn about it in the same
      // commit, or the route would wait forever for an address nobody is going
      // to visit.
      const updatedDelivery = await database.$transaction(async (tx) => {
        // An outcome that settles a stop takes the running route's row
        // before the delivery's, the order a route cancellation takes them
        // in. Delivery first and route second deadlocked against it.
        if (outcome) {
          await this.route.lockRouteOfOpenStop(deliveryId, businessId, tx);
        }

        const updated = await this.delivery.updateDeliveryStatus(
          deliveryId,
          {
            status,
            // What canTransitionDelivery was asked about, three lines up. The
            // write refuses if the row no longer holds it.
            expectedStatus: findDelivery.status,
            // Proof metadata only exists on the proven outcome.
            delivered_at: status === "DELIVERED" ? new Date() : null,
            received_by: status === "DELIVERED" ? (received_by ?? null) : null,
          },
          tx,
        );

        // The trail entry lands in the SAME transaction as the change it
        // describes. Split apart, a crash between them leaves a delivery whose
        // status moved with nothing saying who moved it or why — which is the
        // precise question this whole feature exists to answer.
        //
        // No client_submission_id: only the driver's app resends. Two clicks
        // on the web are two deliberate overrides, and collapsing them would
        // hide that somebody did it twice.
        await this.delivery.createDeliveryEvent(
          {
            type: "STATUS_CHANGE",
            deliveryId,
            reportedById: userId,
            actor: "USER",
            status_from: findDelivery.status,
            status_to: status,
            reasonId,
            note: note?.trim() || null,
          },
          tx,
        );

        // The stop follows the delivery, in this same commit. Before the
        // driver's push below, because whether the driver loses the address
        // depends on it.
        if (outcome) {
          settled = await this.route.settleStopForDelivery(
            deliveryId,
            businessId,
            { ...outcome, onPlanDropped: (bump) => droppedPlans.push(bump) },
            tx,
          );

          releasedFromRoute = Boolean(outcome.releaseDelivery && settled);
        }

        // The driver loses — or gains — a stop, and their app is the last
        // place to find out. Published in the SAME transaction as the change,
        // because a push that survives a crash is the whole reason the outbox
        // exists: the delivery is already cancelled in the database, and a
        // driver who never heard is a driver standing at the address.
        if (
          releasedFromRoute ||
          driverShouldHearOverride({
            from: findDelivery.status,
            to: status,
            driverId: findDelivery.driverId,
          })
        ) {
          const driverUser = await this.user.findUserByDriverId(
            findDelivery.driverId!,
          );

          await this.outbox.publish(tx, {
            topic: "delivery.status_overridden",
            aggregateType: "delivery",
            aggregateId: deliveryId,
            businessId,
            actorId: userId,
            payload: {
              deliveryId,
              businessId,
              driverUserId: driverUser?.id ?? null,
              recipientName: findDelivery.recipient_name,
              addressLabel: [findDelivery.street, findDelivery.city]
                .filter(Boolean)
                .join(", "),
              fromLabel: DELIVERY_STATUS_LABELS[findDelivery.status],
              toLabel: DELIVERY_STATUS_LABELS[status],
              reason: findReason.name,
              note: note?.trim() || null,
              removedFromWorklist:
                releasedFromRoute ||
                !["PENDING", "IN_TRANSIT"].includes(status),
            },
          });
        }

        // And the person waiting for it, when the panel resolved it for them.
        // Only the two outcomes a customer can act on: a delivery moved back
        // to pending or marked in transit is bookkeeping, and a message for
        // every one of those is how somebody learns to ignore the next one.
        const customerTopic =
          status === "DELIVERED"
            ? ("delivery.delivered" as const)
            : status === "FAILED"
              ? ("delivery.failed" as const)
              : null;

        if (customerTopic && hasSomebodyToTell(findDelivery)) {
          await this.outbox.publish(tx, {
            topic: customerTopic,
            aggregateType: "delivery",
            aggregateId: deliveryId,
            businessId,
            actorId: userId,
            payload: {
              ...buildDeliveryCustomerPayload(deliveryId, findDelivery),
              deliveredAt: status === "DELIVERED" ? new Date() : null,
              receivedBy: status === "DELIVERED" ? (received_by ?? null) : null,
            },
          });
        }

        // The customers' systems, for the outcomes the catalogue publishes.
        // A move back to pending or to in-transit is bookkeeping, and an ERP
        // that received an event for each would be an ERP filtering ours out.
        //
        // In the SAME transaction, for the reason the outbox row above is: an
        // event queued after the commit is an event a crash in between erases,
        // and an ERP that never heard the delivery was cancelled keeps billing
        // for it.
        const integrationTopic =
          status === "DELIVERED"
            ? ("delivery.delivered" as const)
            : status === "FAILED"
              ? ("delivery.failed" as const)
              : status === "CANCELLED"
                ? ("delivery.cancelled" as const)
                : status === "IN_TRANSIT"
                  ? ("delivery.in_transit" as const)
                  : null;

        if (integrationTopic) {
          await this.webhooks.announce(
            integrationTopic,
            businessId,
            deliveryEventPayload({ ...findDelivery, id: deliveryId, status }),
            tx,
          );
        }

        await announceRouteClosed(this.webhooks, businessId, settled, tx);

        return updated;
      });

      // The panel and the control tower are watching this stop.
      announceStopSettled(businessId, settled);

      await announceDroppedPlans(this.user, businessId, droppedPlans);

      // No stop settled (no route, or a route that has not left): nothing
      // above told the tower and the boards, which kept the old status until
      // their next poll (DLV-MON-4).
      if (!settled) {
        sendDeliveryStatusToBusiness(businessId, {
          deliveryId,
          deliveryStatus: status,
          routeId: openRoute?.routeId ?? null,
        });
      }

      // And the driver's app, if it is open right now. Not redundant with the
      // push above: the push reaches a phone in a pocket with the app closed,
      // this reaches a screen the driver is looking at, in the second it
      // happens. After the commit, always — an event about a write that rolled
      // back is a lie the client cannot undo.
      if (
        releasedFromRoute ||
        driverShouldHearOverride({
          from: findDelivery.status,
          to: status,
          driverId: findDelivery.driverId,
        })
      ) {
        const driverUser = await this.user.findUserByDriverId(
          findDelivery.driverId!,
        );

        announceDeliveryOverride(driverUser?.id ?? null, {
          type: "delivery.status_overridden",
          deliveryId,
          status,
          removedFromWorklist:
            releasedFromRoute || !["PENDING", "IN_TRANSIT"].includes(status),
        });
      }

      // Process activity asynchronously without blocking the main flow
      this.notificationService.createActivityIfEnabled({
        type: "Entrega",
        action: "update",
        entityId: deliveryId,
        description:
          `Entrega para ${findDelivery.recipient_name}: ` +
          `${DELIVERY_STATUS_LABELS[findDelivery.status]} → ${DELIVERY_STATUS_LABELS[status]}`,
        status: DELIVERY_STATUS_LABELS[status],
        performedBy: userId,
        businessId,
      });

      return updatedDelivery;
    } catch (error) {
      // 409, not 500: the request was well formed and the caller was allowed
      // to make it — somebody else simply got there first. The screen has to
      // be able to tell the operator to refresh, not to try again.
      if (error instanceof DeliveryStatusConflictError) {
        throw new AppError(error.message, 409, "DELIVERY_STATUS_CONFLICT");
      }

      if (error instanceof AppError) {
        throw error;
      }

      throw new AppError(
        "Houve um erro ao tentar mudar o status da entrega! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { UpdateDeliveryStatusUseCase };
