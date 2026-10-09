import { inject, injectable } from "tsyringe";

import database from "@/../infra/database";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IDeliveryRepository } from "../../repositories/IDelivery-repository";
import { IRouteRepository } from "@/modules/route/repositories/IRoute-repository";
import type { IOccurrenceAuthorizationRepository } from "../../repositories/IOccurrence-authorization-repository";
import { IProofAuditRepository } from "../../repositories/IProof-audit-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { NotificationService } from "@/shared/services/notification-service";
import { OutboxService } from "@/shared/notifications/outbox-service";
import { WebhookFanOutService } from "@/shared/integration/webhook-fan-out-service";

import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";
import { assertDispatcher } from "@/shared/delivery/dispatcher-guard";
import { callerNotFound } from "@/shared/delivery/caller-not-found";
import { AppError } from "@/shared/errors/AppError";

import {
  canTransitionDelivery,
  DELIVERY_STATUS_LABELS,
  type DeliveryStatus,
} from "@/shared/delivery/delivery-rules";
import { permissionDenied } from "@/shared/errors/access-errors";
import type { PermissionPrincipal } from "@/modules/middlewares/verify-permission";

import { canDecideAuthorizations } from "./decider-rule";

import { announceDroppedPlans } from "@/modules/route/usecases/shared/route-plan-change";
import type { PlanBump } from "@/modules/route/dtos/route-dto";
import { announceStopSettled } from "@/shared/route/route-realtime";
import {
  sendDeliveryStatusToBusiness,
  sendOccurrenceAuthorizationToBusiness,
  sendOccurrenceDecisionToDriver,
} from "@/websocket";

import { DeliveryNotFoundError, DeliveryStatusConflictError } from "../errors/delivery-errors";

import {
  announceOccurrenceEffect,
  flipDeliveryForOccurrence,
  type OccurrenceEffectDeps,
  type SettledStop,
} from "../report-delivery-occurrence/occurrence-effect";
import {
  applyDeliveryProof,
  requestProofAnalysis,
} from "../register-delivery-proof/delivery-proof-effect";

import {
  AuthorizationNoteRequiredError,
  OccurrenceAlreadyDecidedError,
  OccurrenceAuthorizationNotRequiredError,
  OccurrenceNotFoundError,
  type SettledDecision,
} from "./occurrence-authorization-errors";

import type { OccurrenceForDecision } from "../../repositories/IOccurrence-authorization-repository";
import type { OccurrenceTicketService } from "@/modules/chat/usecases/shared/ticket-operations";

interface DecideOccurrenceAuthorizationRequest {
  userId: string;
  businessId: string;
  occurrenceId: string;
  decision: "APPROVED" | "DENIED";
  /** Required on a denial: it is what the driver reads. */
  note?: string | null;
}

interface DecideOccurrenceAuthorizationResult {
  id: string;
  deliveryId: string;
  authorization_status: "APPROVED" | "DENIED";
  authorized_at: Date;
  authorizedBy: { id: string; name: string };
  authorization_note: string | null;
  /** The delivery's status after the decision. */
  deliveryStatus: DeliveryStatus;
  /** True when the same person had already given this same answer. */
  replayed: boolean;
}

/** Thrown inside the transaction when the conditional update lost. */
class DecisionLostError extends Error {}

/**
 * The tower answers a driver's report (decision 6.3).
 *
 * Exactly one decision per request, whoever clicks: the write is conditional
 * on PENDING and the second operator gets 409 with the decision that stands.
 * The same person repeating the same answer (a double click, a retried
 * request) gets that answer back as a success, with no second effect.
 *
 * An approval applies the type's effect at that moment — the same writer as
 * a report that needs no authorization (occurrence-effect): FAILED, the stop,
 * the notices, the webhooks. A denial applies nothing; the driver is told why.
 */
@injectable()
class DecideOccurrenceAuthorizationUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("DeliveryRepository")
    private delivery: IDeliveryRepository,
    @inject("RouteRepository")
    private route: IRouteRepository,
    @inject("OccurrenceAuthorizationRepository")
    private authorizations: IOccurrenceAuthorizationRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
    @inject("OutboxService")
    private outbox: OutboxService,
    @inject("WebhookFanOutService")
    private webhooks: WebhookFanOutService,
    @inject("ProofAuditRepository")
    private audits: IProofAuditRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    // Decision 14.5: the decision closes the occurrence's support ticket.
    // Optional so callers built before the tickets keep working.
    @inject("OccurrenceTicketService")
    private occurrenceTickets?: OccurrenceTicketService,
  ) {}

  private get effectDeps(): OccurrenceEffectDeps {
    return {
      delivery: this.delivery,
      route: this.route,
      outbox: this.outbox,
      webhooks: this.webhooks,
    };
  }

  async execute({
    userId,
    businessId,
    occurrenceId,
    decision,
    note,
  }: DecideOccurrenceAuthorizationRequest): Promise<DecideOccurrenceAuthorizationResult> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw callerNotFound();
    }

    // The route refuses driver tokens (PERMISSION_DENIED); this is the use
    // case's own line, for any future caller.
    assertDispatcher(findUser);
    assertTenantAccess(findUser, businessId);

    // The route's guard, restated for any other caller: the same rule the
    // panel report uses to decide whether its author self-authorizes.
    if (!canDecideAuthorizations(findUser as unknown as PermissionPrincipal)) {
      throw permissionDenied("Seu perfil de acesso permite apenas a leitura desta seção.");
    }

    const reason = note?.trim() ? note : null;

    if (decision === "DENIED" && !reason) {
      throw new AuthorizationNoteRequiredError();
    }

    const found = await this.authorizations.findForDecision(occurrenceId, businessId);

    if (!found) {
      throw new OccurrenceNotFoundError();
    }

    if (found.authorization_status === "NOT_REQUIRED") {
      throw new OccurrenceAuthorizationNotRequiredError();
    }

    if (found.authorization_status !== "PENDING") {
      return this.answerSettled(found, decision, userId);
    }

    const findDelivery = await this.delivery.findDeliveryById(found.deliveryId);

    if (!findDelivery || findDelivery.businessId !== businessId) {
      throw new DeliveryNotFoundError();
    }

    const blocks = found.occurrenceType.blocks_delivery === true;
    // Decision 14.3: approving a delivery request IS proving the delivery.
    const delivers = found.category === "DELIVERED";
    const decidedAt = new Date();
    // When the receipt was signed, not when the tower answered (design §4.5).
    const provenAt = found.occurred_at ?? found.created_at;

    // The delivery's status under the lock, before and after the decision.
    let previousStatus: DeliveryStatus = findDelivery.status;
    let nextStatus: DeliveryStatus = findDelivery.status;
    let settled: SettledStop = null;
    let superseded = false;
    let ticketId: string | null = null;
    // Other requests of the delivery this approval's proof superseded
    // (tickets design §5.2), announced after the commit.
    const supersededTickets = new Set<string>();
    // Plans a stop came off (design §7.1), announced after the commit.
    const droppedPlans: PlanBump[] = [];

    const openStop = await this.delivery.findOpenStopRoute(found.deliveryId);

    try {
      await database.$transaction(async (tx) => {
        // The route first, then the delivery, then the occurrence: the order
        // a cancellation and a proof take them in.
        if (decision === "APPROVED" && (blocks || delivers)) {
          await this.route.lockRouteOfOpenStop(found.deliveryId, businessId, tx);
        }

        // Is there still an attempt to authorize? Read under the delivery's
        // lock, so a route cancelled, a delivery cancelled or moved to
        // another route between the read above and now is seen: a late
        // approval must not fail a delivery that is already elsewhere, nor
        // settle the stop of a route it was never about.
        const attempt = await this.authorizations.lockAttempt(
          occurrenceId,
          businessId,
          tx,
        );

        if (!attempt) throw new OccurrenceNotFoundError();

        // A delivery that can no longer become DELIVERED has no attempt left
        // for a delivery request to be about.
        const deliverable =
          !delivers ||
          decision !== "APPROVED" ||
          canTransitionDelivery(attempt.deliveryStatus, "DELIVERED").allowed;

        if (!attempt.live || !deliverable) {
          // Nothing left to authorize: the request closes instead, and the
          // operator hears SUPERSEDED like after a proof.
          const closed = await this.authorizations.supersede(occurrenceId, businessId, tx);

          if (!closed) throw new DecisionLostError();

          // The trail says the attempt ended; the ticket stays open for a
          // person to close (design §5.2).
          const ticket = await this.occurrenceTickets?.recordSuperseded(
            { occurrenceId, businessId },
            tx,
          );
          ticketId = ticket?.id ?? null;

          superseded = true;
          return;
        }

        previousStatus = attempt.deliveryStatus;
        nextStatus = attempt.deliveryStatus;

        if (decision === "APPROVED" && blocks) {
          nextStatus = await flipDeliveryForOccurrence(this.effectDeps, {
            tx,
            deliveryId: found.deliveryId,
            currentStatus: previousStatus,
            blocksDelivery: true,
          });
        }

        const decided = await this.authorizations.decide(
          {
            occurrenceId,
            businessId,
            status: decision,
            authorizedById: userId,
            note: reason,
            at: decidedAt,
          },
          tx,
        );

        // Somebody decided first (or the proof superseded it): nothing of this
        // request may commit, the status flip above included.
        if (!decided) throw new DecisionLostError();

        if (decision === "APPROVED" && delivers) {
          // APPROVED is written above, before the proof: the proof's
          // supersede of PENDING requests reaches only the others.
          settled = await applyDeliveryProof(
            { ...this.effectDeps, audits: this.audits, tickets: this.occurrenceTickets },
            {
              tx,
              businessId,
              deliveryId: found.deliveryId,
              delivery: findDelivery,
              expectedStatus: previousStatus,
              reportedById: found.reportedById,
              actorId: userId,
              occurrenceId,
              receiptPhoto: found.receipt_photo,
              signature: found.signature,
              receivedBy: found.received_by,
              latitude: found.latitude,
              longitude: found.longitude,
              provenAt,
              occurredAt: provenAt,
              eventSubmissionId: null,
              onTicketSuperseded: (id) => supersededTickets.add(id),
              onPlanDropped: (bump) => droppedPlans.push(bump),
            },
          );

          nextStatus = "DELIVERED";
        } else if (decision === "APPROVED") {
          if (nextStatus !== previousStatus) {
            // The insucesso happens at the approval (dash-time/tower notes):
            // the failure fact the day counts is this event, at this instant.
            await this.delivery.createDeliveryEvent(
              {
                type: "STATUS_CHANGE",
                deliveryId: found.deliveryId,
                reportedById: userId,
                actor: "USER",
                status_from: previousStatus,
                status_to: nextStatus,
                note: reason
                  ? `Ocorrência "${found.occurrenceType.name}" autorizada: ${reason}`
                  : `Ocorrência "${found.occurrenceType.name}" autorizada pela torre.`,
                occurrenceId,
                routeId: openStop?.routeId ?? null,
              },
              tx,
            );
          }

          settled = await announceOccurrenceEffect(this.effectDeps, {
            tx,
            businessId,
            deliveryId: found.deliveryId,
            delivery: findDelivery,
            previousStatus,
            nextStatus,
            occurrenceTypeName: found.occurrenceType.name,
            blocksDelivery: blocks,
            description: found.description,
            photosCount: found.photos.length,
            actorId: userId,
            reporterName: found.reportedBy.name,
            at: decidedAt,
            onPlanDropped: (bump) => droppedPlans.push(bump),
          });
        }

        // Decision 14.5: the ticket closes with the decision, in this
        // transaction and last (lock order: route, delivery, occurrence,
        // ticket). A lost decision rolls the close back with everything else.
        const closedTicket = await this.occurrenceTickets?.closeForOccurrence(
          {
            occurrenceId,
            businessId,
            closedById: userId,
            actorName: findUser.name,
            outcome: decision,
            note: reason,
            at: decidedAt,
          },
          tx,
        );
        ticketId = closedTicket?.id ?? null;

        // The driver who asked hears the answer on the phone's tray.
        await this.outbox.publish(tx, {
          topic: "delivery-occurrence.authorization_decided",
          aggregateType: "delivery",
          aggregateId: found.deliveryId,
          businessId,
          actorId: userId,
          eventKey: `delivery-occurrence.authorization_decided:${occurrenceId}`,
          payload: {
            occurrenceId,
            deliveryId: found.deliveryId,
            businessId,
            driverUserId: found.reportedBy.driverId ? found.reportedBy.id : null,
            recipientName: findDelivery.recipient_name,
            occurrenceTypeName: found.occurrenceType.name,
            decision,
            note: reason,
            deciderName: findUser.name,
            deliveryStatusAfter: DELIVERY_STATUS_LABELS[nextStatus],
            deliveryStatus: nextStatus,
            category: delivers ? "DELIVERED" : "NOT_DELIVERED",
            ticketId,
          },
        });
      });
    } catch (error) {
      // The delivery moved under the approval (the proof committed first and
      // superseded the request), or another operator won: answer with what
      // stands now.
      if (error instanceof DecisionLostError || error instanceof DeliveryStatusConflictError) {
        const current = await this.reread(occurrenceId, businessId);

        if (current.authorization_status !== "PENDING") {
          return this.answerSettled(current, decision, userId);
        }

        throw new AppError(
          "O status da entrega mudou enquanto você decidia e nada foi gravado. Atualize e decida de novo.",
          409,
          "DELIVERY_STATUS_CONFLICT",
        );
      }

      throw error;
    }

    if (superseded) {
      if (ticketId) {
        await this.occurrenceTickets?.announce({
          ticketId,
          businessId,
          type: "ticket.authorization_changed",
          actor: null,
        });
      }

      // Committed: every open queue drops it; the operator reads why.
      sendOccurrenceAuthorizationToBusiness(businessId, {
        type: "occurrence.authorization_superseded",
        occurrenceId,
        deliveryId: found.deliveryId,
        status: "SUPERSEDED",
      });

      return this.answerSettled(await this.reread(occurrenceId, businessId), decision, userId);
    }

    // The receipt is read once the delivery is proven, with the instant of
    // the receipt: the same request (and unit) a direct proof would make.
    if (decision === "APPROVED" && delivers && found.receipt_photo) {
      await requestProofAnalysis(this.business, {
        deliveryId: found.deliveryId,
        businessId,
        requestedById: found.reportedById,
        photoPath: found.receipt_photo,
        signaturePath: found.signature,
        delivery: findDelivery,
        provenAt,
      });
    }

    announceStopSettled(businessId, settled);

    await announceDroppedPlans(this.user, businessId, droppedPlans);

    for (const changed of supersededTickets) {
      await this.occurrenceTickets?.announce({
        ticketId: changed,
        businessId,
        type: "ticket.authorization_changed",
        actor: null,
      });
    }

    if (ticketId) {
      await this.occurrenceTickets?.announce({
        ticketId,
        businessId,
        type: "ticket.closed",
        actor: { id: findUser.id, name: findUser.name },
      });
    }

    // A flip with no stop to settle (no route, or a route that has not left)
    // still moves the boards' numbers.
    if (nextStatus !== previousStatus && !settled) {
      sendDeliveryStatusToBusiness(businessId, {
        deliveryId: found.deliveryId,
        deliveryStatus: nextStatus,
        routeId: openStop?.routeId ?? null,
      });
    }

    sendOccurrenceAuthorizationToBusiness(businessId, {
      type: "occurrence.authorization_decided",
      occurrenceId,
      deliveryId: found.deliveryId,
      status: decision,
      category: delivers ? "DELIVERED" : "NOT_DELIVERED",
    });

    sendOccurrenceDecisionToDriver(
      found.reportedBy.driverId ? found.reportedBy.id : null,
      {
        type: "occurrence.authorization_decided",
        deliveryId: found.deliveryId,
        occurrenceId,
        decision,
        note: reason,
        deliveryStatus: nextStatus,
        category: delivers ? "DELIVERED" : "NOT_DELIVERED",
      },
    );

    this.notificationService.createActivityIfEnabled({
      type: "Entrega",
      action: "update",
      entityId: found.deliveryId,
      description:
        `Ocorrência "${found.occurrenceType.name}" ${decision === "APPROVED" ? "autorizada" : "negada"} ` +
        `na entrega para ${findDelivery.recipient_name}` +
        (reason ? `: ${reason}` : ""),
      // The delivery's status after the decision, as the report path records
      // it: the activity catalogue's statuses are the delivery's own.
      status: DELIVERY_STATUS_LABELS[nextStatus],
      performedBy: userId,
      businessId,
    });

    return {
      id: occurrenceId,
      deliveryId: found.deliveryId,
      authorization_status: decision,
      authorized_at: decidedAt,
      authorizedBy: { id: findUser.id, name: findUser.name },
      authorization_note: reason,
      deliveryStatus: nextStatus,
      replayed: false,
    };
  }

  private async reread(
    occurrenceId: string,
    businessId: string,
  ): Promise<OccurrenceForDecision> {
    const current = await this.authorizations.findForDecision(occurrenceId, businessId);

    if (!current) throw new OccurrenceNotFoundError();

    return current;
  }

  /**
   * A request that is no longer PENDING: the same person's same answer is a
   * replay (200, nothing written again); anything else is 409 with the
   * decision that stands.
   */
  private async answerSettled(
    found: OccurrenceForDecision,
    decision: "APPROVED" | "DENIED",
    userId: string,
  ): Promise<DecideOccurrenceAuthorizationResult> {
    if (
      found.authorization_status === decision &&
      found.authorizedById === userId &&
      found.authorizedBy &&
      found.authorized_at
    ) {
      const delivery = await this.delivery.findDeliveryById(found.deliveryId);

      return {
        id: found.id,
        deliveryId: found.deliveryId,
        authorization_status: decision,
        authorized_at: found.authorized_at,
        authorizedBy: found.authorizedBy,
        authorization_note: found.authorization_note,
        deliveryStatus: (delivery?.status ?? "PENDING") as DeliveryStatus,
        replayed: true,
      };
    }

    throw new OccurrenceAlreadyDecidedError({
      status: found.authorization_status as SettledDecision["status"],
      authorizedBy: found.authorizedBy,
      authorized_at: found.authorized_at,
      note: found.authorization_note,
    });
  }
}

export { DecideOccurrenceAuthorizationUseCase };
export type {
  DecideOccurrenceAuthorizationRequest,
  DecideOccurrenceAuthorizationResult,
};
