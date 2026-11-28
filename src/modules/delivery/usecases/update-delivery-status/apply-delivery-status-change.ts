import type { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import type { IDeliveryRepository } from "../../repositories/IDelivery-repository";
import type { IRouteRepository } from "@/modules/route/repositories/IRoute-repository";

import database from "@/../infra/database";

import type { NotificationService } from "@/shared/services/notification-service";

import {
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

import type { WebhookFanOutService } from "@/shared/integration/webhook-fan-out-service";
import {
  announceRouteClosed,
  deliveryEventPayload,
} from "@/shared/integration/announce";
import type { OutboxService } from "@/shared/notifications/outbox-service";

import type { Delivery } from "../../dtos/delivery-dto";

import { sendDeliveryStatusToBusiness } from "@/websocket";

/**
 * Who moved it: a person on the panel, or a customer's system through an API
 * key (L9). A key has no user, so the trail names the actor INTEGRATION and
 * the key, and no user id is invented for it.
 */
type StatusChangeActor =
  | { kind: "USER"; userId: string }
  | { kind: "INTEGRATION"; apiKeyId: string; apiKeyName: string };

/**
 * Why. The panel picks a reason from the company's catalogue and may add a
 * note; an integration sends its own words, which no catalogue holds. Those
 * words are the trail's detail (the event has no reason row to point at) and
 * the reason the driver's push reads, never both at once: a push that said
 * the same sentence twice is one the driver learns to skim.
 */
type StatusChangeReason =
  | { kind: "CATALOGUE"; id: string; name: string; note: string | null }
  | { kind: "TEXT"; text: string };

interface ApplyDeliveryStatusChangeInput {
  businessId: string;
  deliveryId: string;

  /**
   * As the caller read it: already in this company, and its move to `status`
   * already allowed by canTransitionDelivery. The write below refuses if the
   * row no longer holds `delivery.status`.
   */
  delivery: Delivery;

  status: DeliveryStatus;
  received_by?: string | null;

  actor: StatusChangeActor;
  reason: StatusChangeReason;

  /** The route of the delivery's open stop, as findOpenStopRoute read it. */
  openRoute: { routeId: string } | null;
}

interface DeliveryStatusChangeDeps {
  users: IUserRepository;
  deliveries: IDeliveryRepository;
  routes: IRouteRepository;
  outbox: OutboxService;
  webhooks: WebhookFanOutService;
  notificationService: NotificationService;
}

/**
 * The one writer of a status moved by hand, for a person on the panel and
 * for an API key alike: same lock order, same stop outcome, same outbox and
 * webhook rows in the same commit, same announcements after it. Two copies
 * of this transaction would be two writers for one fact, and the first fix
 * applied to only one of them (the route lock taken before the delivery's,
 * route-cancel-lock-order) is how they would start disagreeing.
 *
 * Throws DeliveryStatusConflictError (nothing written) when the row moved
 * since the caller read it; each caller answers that in its own words.
 */
async function applyDeliveryStatusChange(
  deps: DeliveryStatusChangeDeps,
  input: ApplyDeliveryStatusChangeInput,
): Promise<Delivery> {
  const {
    businessId,
    deliveryId,
    delivery: findDelivery,
    status,
    received_by,
    actor,
    reason,
    openRoute,
  } = input;

  const userId = actor.kind === "USER" ? actor.userId : null;

  // The catalogue's name and the operator's note, or the integration's words
  // as the reason alone (see StatusChangeReason).
  const noticeReason = reason.kind === "CATALOGUE" ? reason.name : reason.text;
  const noticeNote = reason.kind === "CATALOGUE" ? reason.note : null;

  // Captured to be announced AFTER the commit: a socket event about a
  // write that rolled back is a lie the client cannot undo.
  let settled: Awaited<ReturnType<IRouteRepository["settleStopForDelivery"]>> =
    null;

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
      await deps.routes.lockRouteOfOpenStop(deliveryId, businessId, tx);
    }

    const updated = await deps.deliveries.updateDeliveryStatus(
      deliveryId,
      {
        status,
        // What the caller asked canTransitionDelivery about. The write
        // refuses if the row no longer holds it.
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
    // hide that somebody did it twice. An integration's repeat never gets
    // here: its caller answers a cancelled delivery as a replay.
    await deps.deliveries.createDeliveryEvent(
      {
        type: "STATUS_CHANGE",
        deliveryId,
        reportedById: userId,
        actor: actor.kind,
        // Which key, so the trail names it (L9); null for a person.
        apiKeyId: actor.kind === "INTEGRATION" ? actor.apiKeyId : null,
        status_from: findDelivery.status,
        status_to: status,
        reasonId: reason.kind === "CATALOGUE" ? reason.id : null,
        note: reason.kind === "CATALOGUE" ? reason.note : reason.text,
      },
      tx,
    );

    // The stop follows the delivery, in this same commit. Before the
    // driver's push below, because whether the driver loses the address
    // depends on it.
    if (outcome) {
      settled = await deps.routes.settleStopForDelivery(
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
      const driverUser = await deps.users.findUserByDriverId(
        findDelivery.driverId!,
      );

      await deps.outbox.publish(tx, {
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
          reason: noticeReason,
          note: noticeNote,
          removedFromWorklist:
            releasedFromRoute || !["PENDING", "IN_TRANSIT"].includes(status),
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
      await deps.outbox.publish(tx, {
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
      await deps.webhooks.announce(
        integrationTopic,
        businessId,
        deliveryEventPayload({ ...findDelivery, id: deliveryId, status }),
        tx,
      );
    }

    await announceRouteClosed(deps.webhooks, businessId, settled, tx);

    return updated;
  });

  // The panel and the control tower are watching this stop.
  announceStopSettled(businessId, settled);

  await announceDroppedPlans(deps.users, businessId, droppedPlans, userId);

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
    const driverUser = await deps.users.findUserByDriverId(
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

  const move =
    `Entrega para ${findDelivery.recipient_name}: ` +
    `${DELIVERY_STATUS_LABELS[findDelivery.status]} → ${DELIVERY_STATUS_LABELS[status]}`;

  // Process activity asynchronously without blocking the main flow. A key
  // is no user: performedBy stays null and the description names the key,
  // as the integration's create does.
  deps.notificationService.createActivityIfEnabled({
    type: "Entrega",
    action: "update",
    entityId: deliveryId,
    description:
      actor.kind === "USER"
        ? move
        : `${move} pela integração «${actor.apiKeyName}» | ID: ${deliveryId}`,
    status: DELIVERY_STATUS_LABELS[status],
    performedBy: userId,
    businessId,
  });

  return updatedDelivery;
}

export { applyDeliveryStatusChange };
export type {
  ApplyDeliveryStatusChangeInput,
  DeliveryStatusChangeDeps,
  StatusChangeActor,
  StatusChangeReason,
};
