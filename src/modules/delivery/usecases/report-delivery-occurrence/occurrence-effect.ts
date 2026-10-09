import { Prisma } from "@prisma/client";

import type { IDeliveryRepository } from "../../repositories/IDelivery-repository";
import type { IRouteRepository } from "@/modules/route/repositories/IRoute-repository";
import type { Delivery } from "../../dtos/delivery-dto";
import type { PlanBump } from "@/modules/route/dtos/route-dto";

import type { OutboxService } from "@/shared/notifications/outbox-service";
import type { WebhookFanOutService } from "@/shared/integration/webhook-fan-out-service";

import {
  DELIVERY_STATUS_LABELS,
  statusAfterOccurrence,
  type DeliveryStatus,
} from "@/shared/delivery/delivery-rules";
import { stopOutcomeForDelivery } from "@/shared/route/route-rules";

import {
  announceRouteClosed,
  deliveryEventPayload,
} from "@/shared/integration/announce";
import {
  buildDeliveryCustomerPayload,
  hasSomebodyToTell,
} from "@/shared/delivery/customer-notice";

/**
 * What an occurrence DOES to a delivery, in one place.
 *
 * Two paths apply it: a report on a type that needs no authorization (at the
 * report), and the tower's approval of one that did (at the approval,
 * decision 6.3). They used to be one inline block in the report; a second
 * copy for the approval would be a second chance for the two to drift — an
 * approved insucesso that settles the stop but never tells the shipper.
 *
 * Split in two because the approval must lock the delivery row BEFORE it
 * decides the occurrence (the order a proof takes them in), while the rest
 * of the effect comes after the decision.
 */

interface OccurrenceEffectDeps {
  delivery: IDeliveryRepository;
  route: IRouteRepository;
  outbox: OutboxService;
  webhooks: WebhookFanOutService;
}

type SettledStop = Awaited<ReturnType<IRouteRepository["settleStopForDelivery"]>>;

/**
 * The status the occurrence leads to, written when it changes anything.
 *
 * Guarded by the status read before (expectedStatus): a delivery proven or
 * cancelled meanwhile throws DeliveryStatusConflictError and the whole
 * transaction rolls back. The caller locks the route first when it may flip.
 */
async function flipDeliveryForOccurrence(
  deps: Pick<OccurrenceEffectDeps, "delivery">,
  input: {
    tx: Prisma.TransactionClient;
    deliveryId: string;
    currentStatus: DeliveryStatus;
    blocksDelivery: boolean;
  },
): Promise<DeliveryStatus> {
  const nextStatus = statusAfterOccurrence(input.currentStatus, input.blocksDelivery);

  if (nextStatus !== input.currentStatus) {
    await deps.delivery.updateDeliveryStatus(
      input.deliveryId,
      { status: nextStatus, expectedStatus: input.currentStatus },
      input.tx,
    );
  }

  return nextStatus;
}

interface AnnounceOccurrenceEffectInput {
  tx: Prisma.TransactionClient;
  businessId: string;
  deliveryId: string;

  /** The delivery as read before the transaction changed it. */
  delivery: Delivery;
  previousStatus: DeliveryStatus;
  nextStatus: DeliveryStatus;

  occurrenceTypeName: string;
  blocksDelivery: boolean;
  description: string | null;
  photosCount: number;

  /** Who caused the effect: the reporter, or the approver. */
  actorId: string;
  reporterName: string;

  /** When the effect happened: the report's moment, or the approval's. */
  at: Date;

  /**
   * Told when the stop came off a plan that had not left (design §7.1), so
   * the caller announces route.stops_changed AFTER its commit.
   */
  onPlanDropped?: (bump: PlanBump) => void;
}

/**
 * Everything after the flip, in the caller's transaction: the stop closes
 * with the outcome (the route ends by itself on its last stop), the
 * operators are told of an insucesso, and the shipper's systems and the
 * person waiting hear what the manual path would have told them.
 */
async function announceOccurrenceEffect(
  deps: OccurrenceEffectDeps,
  input: AnnounceOccurrenceEffectInput,
): Promise<SettledStop> {
  const changed = input.nextStatus !== input.previousStatus;

  let settled: SettledStop = null;

  if (changed) {
    const outcome = stopOutcomeForDelivery(input.nextStatus, input.at);

    if (outcome) {
      settled = await deps.route.settleStopForDelivery(
        input.deliveryId,
        input.businessId,
        { ...outcome, onPlanDropped: input.onPlanDropped },
        input.tx,
      );
    }
  }

  // Only a blocking occurrence that CHANGED the delivery's fate rings the
  // operators: one on a delivery already finished changes nothing.
  if (input.blocksDelivery && changed) {
    await deps.outbox.publish(input.tx, {
      topic: "delivery-occurrence.reported",
      aggregateType: "delivery",
      aggregateId: input.deliveryId,
      businessId: input.businessId,
      actorId: input.actorId,
      payload: {
        deliveryId: input.deliveryId,
        businessId: input.businessId,
        recipientName: input.delivery.recipient_name,
        occurrenceTypeName: input.occurrenceTypeName,
        blocksDelivery: true,
        description: input.description,
        photosCount: input.photosCount,
        reporterName: input.reporterName,
        deliveryStatusAfter: DELIVERY_STATUS_LABELS[input.nextStatus],
      },
    });
  }

  // The customers' systems, with the status AFTER the occurrence, in the
  // same transaction: an event queued after the commit is one a crash erases.
  await deps.webhooks.announce(
    "occurrence.reported",
    input.businessId,
    {
      ...deliveryEventPayload(
        { ...input.delivery, id: input.deliveryId, status: input.nextStatus },
        input.at,
      ),
      occurrence_type: input.occurrenceTypeName,
      blocks_delivery: input.blocksDelivery,
      description: input.description,
    },
    input.tx,
  );

  // A blocking occurrence is how a driver fails a delivery in the field: the
  // integrations hear delivery.failed and the person waiting is told, as on
  // the panel's path — only when it changed the delivery's fate.
  if (input.nextStatus === "FAILED" && changed) {
    if (hasSomebodyToTell(input.delivery)) {
      await deps.outbox.publish(input.tx, {
        topic: "delivery.failed",
        aggregateType: "delivery",
        aggregateId: input.deliveryId,
        businessId: input.businessId,
        actorId: input.actorId,
        payload: {
          ...buildDeliveryCustomerPayload(input.deliveryId, input.delivery),
          deliveredAt: null,
          receivedBy: null,
        },
      });
    }

    await deps.webhooks.announce(
      "delivery.failed",
      input.businessId,
      deliveryEventPayload(
        { ...input.delivery, id: input.deliveryId, status: input.nextStatus },
        input.at,
      ),
      input.tx,
    );
  }

  await announceRouteClosed(deps.webhooks, input.businessId, settled, input.tx);

  return settled;
}

export {
  announceOccurrenceEffect,
  flipDeliveryForOccurrence,
  type OccurrenceEffectDeps,
  type SettledStop,
};
