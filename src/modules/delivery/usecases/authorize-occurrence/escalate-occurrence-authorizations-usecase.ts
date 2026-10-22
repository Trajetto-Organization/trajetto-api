import { inject, injectable } from "tsyringe";

import database from "@/../infra/database";

import type {
  EscalationClaim,
  IOccurrenceAuthorizationRepository,
} from "../../repositories/IOccurrence-authorization-repository";
import { OutboxService } from "@/shared/notifications/outbox-service";
import type { OccurrenceTicketService } from "@/modules/chat/usecases/shared/ticket-operations";

import { sendOccurrenceAuthorizationToBusiness } from "@/websocket";

import { authorizationRequestedPayload } from "./authorization-notice";
import { ESCALATION_AFTER_MS } from "./list-pending-authorizations-usecase";

/** Per run: a backlog drains over the next minutes rather than in one burst. */
const ESCALATION_BATCH = 100;

interface EscalateRequest {
  now?: Date;
}

/**
 * The minute sweep of the tower's requests (decision 6.3).
 *
 * First it closes as SUPERSEDED every request whose attempt is over — the
 * delivery was cancelled, delivered, failed, returned or moved to another
 * route or driver by some writer that knows nothing about requests
 * (authorization-liveness). Then a live request nobody answered in ten
 * minutes goes to the company's administrators, once.
 *
 * Safe across replicas and repeated runs by construction: both steps are
 * conditional UPDATEs over SKIP LOCKED picks, and the escalation notice is
 * published in the same transaction under a key unique per request — a
 * request is escalated at most once whatever runs the sweep, however often.
 */
@injectable()
class EscalateOccurrenceAuthorizationsUseCase {
  constructor(
    @inject("OccurrenceAuthorizationRepository")
    private authorizations: IOccurrenceAuthorizationRepository,
    @inject("OutboxService")
    private outbox: OutboxService,
    // Decision 14.5 (tickets design §5.2): the occurrence's ticket records
    // the supersede. Optional so callers built before the tickets still work.
    @inject("OccurrenceTicketService")
    private occurrenceTickets?: OccurrenceTicketService,
  ) {}

  async execute({ now = new Date() }: EscalateRequest = {}): Promise<
    EscalationClaim[]
  > {
    const cutoff = new Date(now.getTime() - ESCALATION_AFTER_MS);

    const changedTickets: Array<{ ticketId: string; businessId: string }> = [];

    const closed = await database.$transaction(async (tx) => {
      const rows = await this.authorizations.supersedeStale(
        ESCALATION_BATCH,
        now,
        tx,
      );

      // The trail says the attempt ended, in the same commit; the ticket
      // stays OPEN for a person to close.
      for (const row of rows) {
        const ticket = await this.occurrenceTickets?.recordSuperseded(
          { occurrenceId: row.id, businessId: row.businessId },
          tx,
        );

        if (ticket)
          changedTickets.push({
            ticketId: ticket.id,
            businessId: row.businessId,
          });
      }

      return rows;
    });

    for (const { ticketId, businessId } of changedTickets) {
      await this.occurrenceTickets?.announce({
        ticketId,
        businessId,
        type: "ticket.authorization_changed",
        actor: null,
      });
    }

    // After the commit: the open queues and Ocorrências tabs drop them.
    for (const row of closed) {
      sendOccurrenceAuthorizationToBusiness(row.businessId, {
        type: "occurrence.authorization_superseded",
        occurrenceId: row.id,
        deliveryId: row.deliveryId,
        status: "SUPERSEDED",
      });
    }

    const claimed = await database.$transaction(async (tx) => {
      const rows = await this.authorizations.claimDueEscalations(
        cutoff,
        ESCALATION_BATCH,
        now,
        tx,
      );

      for (const row of rows) {
        await this.outbox.publish(tx, {
          topic: "delivery-occurrence.authorization_escalated",
          aggregateType: "delivery",
          aggregateId: row.deliveryId,
          businessId: row.businessId,
          eventKey: `delivery-occurrence.authorization_escalated:${row.id}`,
          payload: {
            ...authorizationRequestedPayload({
              occurrenceId: row.id,
              deliveryId: row.deliveryId,
              businessId: row.businessId,
              recipientName: row.recipientName,
              occurrenceTypeName: row.occurrenceTypeName,
              blocksDelivery: row.blocksDelivery,
              description: row.description,
              reporterName: row.reporterName,
              fromDriver: row.reporterIsDriver,
              photosCount: row.photosCount,
              formFields: row.formFields,
              answers: row.form_answers,
              requestedAt: row.created_at,
              category: row.category,
            }),
            waitingMinutes: Math.max(
              1,
              Math.floor((now.getTime() - row.created_at.getTime()) / 60_000),
            ),
          },
        });
      }

      return rows;
    });

    // After the commit: the open queues mark it "escalado".
    for (const row of claimed) {
      sendOccurrenceAuthorizationToBusiness(row.businessId, {
        type: "occurrence.authorization_escalated",
        occurrenceId: row.id,
        deliveryId: row.deliveryId,
        status: "PENDING",
        category: row.category === "DELIVERED" ? "DELIVERED" : "NOT_DELIVERED",
      });
    }

    return claimed;
  }
}

export { ESCALATION_BATCH, EscalateOccurrenceAuthorizationsUseCase };
