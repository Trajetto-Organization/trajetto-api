import { Prisma } from "@prisma/client";

import type { IDeliveryRepository } from "../../repositories/IDelivery-repository";
import type { IRouteRepository } from "@/modules/route/repositories/IRoute-repository";
import type { IProofAuditRepository } from "../../repositories/IProof-audit-repository";
import type { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import type { Delivery } from "../../dtos/delivery-dto";
import type { PlanBump } from "@/modules/route/dtos/route-dto";
import type { ProofCapture } from "@/shared/delivery/proof-capture";

import type { OutboxService } from "@/shared/notifications/outbox-service";
import type { WebhookFanOutService } from "@/shared/integration/webhook-fan-out-service";

import type { DeliveryStatus } from "@/shared/delivery/delivery-rules";
import { stopOutcomeForDelivery } from "@/shared/route/route-rules";

import {
  buildDeliveryCustomerPayload,
  hasSomebodyToTell,
} from "@/shared/delivery/customer-notice";
import {
  announceRouteClosed,
  deliveryEventPayload,
} from "@/shared/integration/announce";

import { AIAnalysisService } from "@/shared/ai/ai-analysis-service";
import { buildProofAnalysisInput } from "@/shared/delivery/proof-analysis-input";
import { logger } from "@/shared/logging/logger";
import type { DevicePrecheck } from "@/shared/ai-precheck/device-precheck";
import type { OccurrenceTicketService } from "@/modules/chat/usecases/shared/ticket-operations";

const log = logger.child({ component: "delivery" });

/**
 * What proving a delivery DOES, in one place (decision 14.3; design §4.4).
 *
 * Proving is now reporting a DELIVERED occurrence. Three paths apply it: the
 * report of a delivered type that needs no authorization, the tower's
 * approval of one that did, and the legacy proof route of the installed app
 * (which goes through the report). One writer, so the three cannot drift: a
 * delivery proven by approval that never tells the shipper, or never reaches
 * the audit, is exactly what a copy would eventually do.
 *
 * Extracted mechanically from RegisterDeliveryProofUseCase: same steps, same
 * order (route lock, DELIVERED + PROOF + supersede, stop, outbox, webhooks,
 * route close, audit card).
 */

interface DeliveryProofEffectDeps {
  delivery: IDeliveryRepository;
  route: IRouteRepository;
  outbox: OutboxService;
  webhooks: WebhookFanOutService;
  audits: IProofAuditRepository;

  /**
   * Decision 14.5 (tickets design §5.2): the trail of a request this proof
   * superseded. Optional so callers built before the tickets still work.
   */
  tickets?: Pick<OccurrenceTicketService, "recordSuperseded">;
}

type SettledStop = Awaited<
  ReturnType<IRouteRepository["settleStopForDelivery"]>
>;

interface ApplyDeliveryProofInput {
  tx: Prisma.TransactionClient;
  businessId: string;
  deliveryId: string;

  /** The row read before the transaction (customer notice, webhook body). */
  delivery: Delivery;

  /** The status canTransitionDelivery was asked about: the update's guard. */
  expectedStatus: DeliveryStatus;

  /** Who proved it (the PROOF event's author): the driver. */
  reportedById: string;

  /** Who caused the write now (outbox actor): the driver, or the approver. */
  actorId: string;

  /** The DELIVERED occurrence this proof is the effect of. */
  occurrenceId: string | null;

  receiptPhoto: string | null;
  signature: string | null;
  receivedBy: string | null;
  latitude?: number | null;
  longitude?: number | null;

  /**
   * When the receipt was signed: the tap of a proof sent later (MOB-08), the
   * report's instant for an approval — never the approval's own instant.
   */
  provenAt: Date;

  /** The stored occurred_at (null = received now). */
  occurredAt: Date | null;

  /** The report's client_submission_id, also on the PROOF; null on approval. */
  eventSubmissionId: string | null;

  /**
   * The phone's offline check of this receipt, already accepted (decision
   * 14.2). Absent on an approval: the request did not keep it.
   */
  devicePrecheck?: DevicePrecheck | null;

  /**
   * Told the id of each ticket whose request this proof superseded, so the
   * caller announces `ticket.authorization_changed` AFTER its commit.
   */
  onTicketSuperseded?: (ticketId: string) => void;

  /**
   * Told when the stop came off a plan that had not left (design §7.1), so
   * the caller announces route.stops_changed AFTER its commit.
   */
  onPlanDropped?: (bump: PlanBump) => void;

  /** The photo stamp and the phone (decision 14.8); absent on an approval. */
  capture?: ProofCapture;

  /** The route of the delivery's open stop, when it is on one. */
  routeId?: string | null;
}

/**
 * Writes the proof inside the caller's transaction and returns the stop it
 * settled (announce it AFTER the commit).
 *
 * Throws DeliveryStatusConflictError when the delivery moved since it was
 * read: the whole transaction must roll back.
 */
async function applyDeliveryProof(
  deps: DeliveryProofEffectDeps,
  input: ApplyDeliveryProofInput,
): Promise<SettledStop> {
  const { tx, businessId, deliveryId, delivery } = input;
  let settled: SettledStop = null;

  // The running route's row before the delivery's: the order a route
  // cancellation takes them in. Delivery first and route second (in the
  // settle below) deadlocked against it.
  const lockedRouteId = await deps.route.lockRouteOfOpenStop(
    deliveryId,
    businessId,
    tx,
  );

  // DELIVERED (guarded by the status read before), the PROOF event, and
  // every PENDING request of the delivery superseded (decision 6.3: the
  // proof wins). An approval wrote its own APPROVED first, so only the
  // OTHER pending requests are reached here.
  const superseded = await deps.delivery.registerDeliveryProof(
    {
      type: "PROOF",
      deliveryId,
      reportedById: input.reportedById,
      latitude: input.latitude ?? undefined,
      longitude: input.longitude ?? undefined,
      photo: input.receiptPhoto,
      signature: input.signature,
      received_by: input.receivedBy ?? undefined,
      client_submission_id: input.eventSubmissionId ?? undefined,
      occurred_at: input.occurredAt,
      occurrenceId: input.occurrenceId,
      // Every proof is the driver's (a DELIVERED report is DRIVER_ONLY, and
      // an approval applies the driver's request): design §7.2.
      actor: "DRIVER_APP",
      device: input.capture?.device ?? null,
      device_id: input.capture?.deviceId ?? null,
      photo_taken_at: input.capture?.photoTakenAt ?? null,
      routeId: input.routeId ?? lockedRouteId,
    },
    input.expectedStatus,
    tx,
  );

  // The ticket of each superseded request says so in its trail and stays
  // OPEN, in this same commit (tickets design §5.2).
  for (const occurrenceId of superseded ?? []) {
    const ticket = await deps.tickets?.recordSuperseded(
      { occurrenceId, businessId },
      tx,
    );

    if (ticket) input.onTicketSuperseded?.(ticket.id);
  }

  const outcome = stopOutcomeForDelivery("DELIVERED", input.provenAt);

  if (outcome) {
    settled = await deps.route.settleStopForDelivery(
      deliveryId,
      businessId,
      { ...outcome, onPlanDropped: input.onPlanDropped },
      tx,
    );
  }

  // The person who was waiting for this, in the SAME transaction as the
  // proof: a DELIVERED delivery whose customer was never told is the state
  // the feature exists to prevent. Checked first so a carrier that collects
  // no contact never writes a row that expands into nothing.
  if (hasSomebodyToTell(delivery)) {
    await deps.outbox.publish(tx, {
      topic: "delivery.delivered",
      aggregateType: "delivery",
      aggregateId: deliveryId,
      businessId,
      actorId: input.actorId,
      payload: {
        ...buildDeliveryCustomerPayload(deliveryId, delivery),
        deliveredAt: input.provenAt,
        receivedBy: input.receivedBy ?? null,
      },
    });
  }

  // The customers' systems, same topics and payloads as before 14.3:
  // `delivery.delivered` for an ERP that tracks documents, `proof.registered`
  // for one that audits receipts. In the transaction (a crash after the
  // commit would erase them), stamped with when the receipt was signed and
  // carrying the status AFTER the proof.
  const after = { ...delivery, id: deliveryId, status: "DELIVERED" as const };

  await deps.webhooks.announce(
    "proof.registered",
    businessId,
    deliveryEventPayload(after, input.provenAt),
    tx,
  );

  await deps.webhooks.announce(
    "delivery.delivered",
    businessId,
    deliveryEventPayload(after, input.provenAt),
    tx,
  );

  await announceRouteClosed(deps.webhooks, businessId, settled, tx);

  // The card a person will look at, queued with the proof (INV-08) so a
  // receipt whose analysis never ran still reaches a human. A delivered type
  // that asks for no receipt, proven without one, has nothing to audit.
  if (input.receiptPhoto) {
    await deps.audits.enqueue(deliveryId, businessId, tx, {
      devicePrecheck: input.devicePrecheck ?? null,
    });
  }

  return settled;
}

/**
 * Asks the model to read the receipt, if this company bought that.
 *
 * After the commit and fire-and-forget, like the checklist and the odometer:
 * a failure costs the office a hint, never the driver the proof. The
 * expected values travel WITH the request: the analysis runs minutes later,
 * and the model must be asked about the document that was proven. The input
 * is hashed with `provenAt`, so asking again for the same photo and instant
 * (a pending report, then its approval) is the same request, charged once.
 */
async function requestProofAnalysis(
  business: Pick<IBusinessRepository, "findBusinessById">,
  input: {
    deliveryId: string;
    businessId: string;
    requestedById: string;
    photoPath: string;
    signaturePath: string | null;
    delivery: {
      invoice_number?: string | null;
      code?: string | null;
      recipient_name: string;
    };
    provenAt: Date;
  },
): Promise<void> {
  try {
    const findBusiness = await business.findBusinessById(input.businessId);

    // Zero is how a company says it did not buy this: the card arrives with
    // no suggestion, which is what a reviewer without AI should see.
    if ((findBusiness?.ai_analysis_limit ?? 0) <= 0) return;

    await AIAnalysisService.getInstance().requestAnalysis({
      type: "DELIVERY_PROOF",
      recordId: input.deliveryId,
      businessId: input.businessId,
      requestedById: input.requestedById,
      input: buildProofAnalysisInput({
        photoPath: input.photoPath,
        signaturePath: input.signaturePath,
        delivery: input.delivery,
        provenAt: input.provenAt,
        // The same zone the proof sweep passes: the input is hashed
        // (DLVP-PROOF-4).
        timeZone: findBusiness?.timezone,
      }),
    });
  } catch (error) {
    // Not lost for good: reconcile-proof-analysis-job asks again for a
    // PENDING card that has no request (IDEMP-08).
    log.error(
      {
        err: error,
        deliveryId: input.deliveryId,
        businessId: input.businessId,
      },
      "AI proof verification could not be requested",
    );
  }
}

export { applyDeliveryProof, requestProofAnalysis };
export type { ApplyDeliveryProofInput, DeliveryProofEffectDeps, SettledStop };
