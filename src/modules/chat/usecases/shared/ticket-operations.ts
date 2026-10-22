import { inject, injectable } from "tsyringe";

import type { IChatRepository } from "../../repositories/IChat-repository";
import type { ISupportTicketRepository } from "../../repositories/ISupport-ticket-repository";
import type {
  SupportTicket,
  SupportTicketActorKind,
  SupportTicketOutcome,
} from "../../dtos/support-ticket-dto";

import {
  sendSupportTicketEvent,
  type SupportTicketRealtimeType,
} from "@/websocket";

import { occurrenceTicketSubject } from "./ticket-rules";
import { driverTicketView, presentTicket } from "./ticket-presenter";

/**
 * The ticket writes that other flows make inside THEIR transaction: the
 * occurrence report opens one, the tower's decision closes one, a supersede
 * leaves a trail. Lock order (design §2.5): route → delivery → occurrence →
 * counter → ticket — every caller touches the ticket last.
 */

interface TicketActor {
  kind: SupportTicketActorKind;
  id: string | null;
  name: string | null;
}

interface OpenOccurrenceTicketInput {
  businessId: string;
  deliveryId: string;
  driverId: string;
  occurrenceId: string;
  occurrenceTypeName: string;
  recipientName: string;
  actor: TicketActor;
}

/**
 * The occurrence's ticket, in the report's transaction (design §3.1).
 *
 * An OPEN DELIVERY ticket of the same delivery (the driver was already
 * talking about it) becomes the occurrence's, so the earlier conversation is
 * its context; otherwise a new OCCURRENCE ticket is born.
 */
async function openOccurrenceTicket(
  deps: { tickets: ISupportTicketRepository; chat: IChatRepository },
  input: OpenOccurrenceTicketInput,
  tx: unknown,
): Promise<{ ticket: SupportTicket; linked: boolean }> {
  const existing = await deps.tickets.findOpenForDelivery(
    input.deliveryId,
    input.businessId,
    "DELIVERY",
    tx,
  );

  // Another driver's ticket (the delivery was reassigned) is not this
  // driver's context: the occurrence gets its own ticket instead.
  if (existing && existing.driverId === input.driverId) {
    const ticket = await deps.tickets.linkOccurrence(
      existing.id,
      input.occurrenceId,
      tx,
    );

    await deps.tickets.addEvent(
      {
        ticketId: ticket.id,
        businessId: input.businessId,
        type: "OCCURRENCE_LINKED",
        actor_kind: input.actor.kind,
        actorId: input.actor.id,
        actor_name: input.actor.name,
        note: input.occurrenceTypeName,
      },
      tx,
    );

    return { ticket, linked: true };
  }

  // The thread is the channel: an upsert that converges between replicas,
  // on the report's own connection (a second pooled one mid-transaction
  // starves the pool at peak, and would survive a rollback).
  const thread = await deps.chat.getOrCreateThread(
    input.businessId,
    input.driverId,
    tx,
  );

  const ticket = await deps.tickets.create(
    {
      businessId: input.businessId,
      threadId: thread.id,
      driverId: input.driverId,
      kind: "OCCURRENCE",
      subject: occurrenceTicketSubject(
        input.occurrenceTypeName,
        input.recipientName,
      ),
      deliveryId: input.deliveryId,
      occurrenceId: input.occurrenceId,
      opened_via: "OCCURRENCE_REPORT",
      openedById: input.actor.id,
    },
    tx,
  );

  await deps.tickets.addEvent(
    {
      ticketId: ticket.id,
      businessId: input.businessId,
      type: "OPENED",
      actor_kind: input.actor.kind,
      actorId: input.actor.id,
      actor_name: input.actor.name,
    },
    tx,
  );

  return { ticket, linked: false };
}

interface CloseForOccurrenceInput {
  occurrenceId: string;
  businessId: string;
  closedById: string;
  actorName: string;
  outcome: Extract<SupportTicketOutcome, "APPROVED" | "DENIED">;
  note: string | null;
  at: Date;
}

/**
 * The decision closes the occurrence's ticket in the SAME transaction
 * (design §5.1): deciding from the queue or from the ticket has one effect,
 * and a decided occurrence never leaves a ticket waiting for a decision.
 * "Quem tratou" is never empty on a ticket a person closed.
 */
async function closeTicketForOccurrence(
  tickets: ISupportTicketRepository,
  input: CloseForOccurrenceInput,
  tx: unknown,
): Promise<SupportTicket | null> {
  const found = await tickets.findByOccurrence(
    input.occurrenceId,
    input.businessId,
    tx,
  );

  if (!found) return null;

  const locked = await tickets.lockForUpdate(found.id, input.businessId, tx);

  if (!locked) return null;

  const actor = {
    actor_kind: "USER" as const,
    actorId: input.closedById,
    actor_name: input.actorName,
  };

  if (locked.status === "OPEN" && locked.assigneeId === null) {
    await tickets.assign(
      {
        id: locked.id,
        businessId: input.businessId,
        assigneeId: input.closedById,
        at: input.at,
      },
      tx,
    );

    await tickets.addEvent(
      {
        ticketId: locked.id,
        businessId: input.businessId,
        type: "ASSIGNED",
        ...actor,
        target_user_id: input.closedById,
        target_user_name: input.actorName,
      },
      tx,
    );
  }

  await tickets.addEvent(
    {
      ticketId: locked.id,
      businessId: input.businessId,
      type: "AUTHORIZATION_DECIDED",
      ...actor,
      outcome: input.outcome,
      note: input.note,
    },
    tx,
  );

  if (locked.status === "OPEN") {
    await tickets.close(
      {
        id: locked.id,
        businessId: input.businessId,
        closedById: input.closedById,
        outcome: input.outcome,
        note: input.note,
        at: input.at,
      },
      tx,
    );

    await tickets.addEvent(
      {
        ticketId: locked.id,
        businessId: input.businessId,
        type: "CLOSED",
        ...actor,
        outcome: input.outcome,
        note: input.note,
      },
      tx,
    );
  } else {
    await tickets.bumpVersion(locked.id, tx);
  }

  return tickets.findById(locked.id, input.businessId, tx);
}

/**
 * The attempt ended before anyone decided (a proof, a cancellation): the
 * trail says so and the ticket stays OPEN — closing is a person's act with a
 * name (design §5.2).
 */
async function recordAuthorizationSuperseded(
  tickets: ISupportTicketRepository,
  input: { occurrenceId: string; businessId: string },
  tx: unknown,
): Promise<SupportTicket | null> {
  const found = await tickets.findByOccurrence(
    input.occurrenceId,
    input.businessId,
    tx,
  );

  if (!found) return null;

  await tickets.addEvent(
    {
      ticketId: found.id,
      businessId: input.businessId,
      type: "AUTHORIZATION_SUPERSEDED",
      actor_kind: "SYSTEM",
    },
    tx,
  );

  return tickets.bumpVersion(found.id, tx);
}

/**
 * Announces a ticket change after the commit, to the tower and (for the
 * subjects that change his conversation) to the driver.
 */
async function announceTicket(
  tickets: ISupportTicketRepository,
  input: {
    ticketId: string;
    businessId: string;
    type: SupportTicketRealtimeType;
    actor: { id: string; name: string } | null;
    alert?: {
      reason: "AUTHORIZATION" | "OCCURRENCE" | "DRIVER_OPENED";
      occurrenceTypeName?: string;
      recipientName?: string;
    };
  },
): Promise<void> {
  try {
    const row = await tickets.findRowById(input.ticketId, input.businessId);

    if (!row) return;

    // Per-user unread is not part of a broadcast.
    const { unreadCount: _unread, ...ticket } = presentTicket(row);

    sendSupportTicketEvent(
      input.businessId,
      row.driverUserId,
      {
        type: input.type,
        ticket,
        actor: input.actor,
        ...(input.alert && {
          alert: { ...input.alert, driverName: row.driver.name },
        }),
      },
      driverTicketView({ ...ticket, unreadCount: 0 }),
    );
  } catch {
    // Realtime is a hint; the summary query is the truth (design §6.6).
  }
}

export {
  OccurrenceTicketService,
  openOccurrenceTicket,
  closeTicketForOccurrence,
  recordAuthorizationSuperseded,
  announceTicket,
};
export type { TicketActor, OpenOccurrenceTicketInput, CloseForOccurrenceInput };

/**
 * The single dependency the delivery flows take (report, decision) to reach
 * the tickets: one optional constructor slot instead of two repositories.
 */
@injectable()
class OccurrenceTicketService {
  constructor(
    @inject("SupportTicketRepository")
    private tickets: ISupportTicketRepository,
    @inject("ChatRepository")
    private chat: IChatRepository,
  ) {}

  open(input: OpenOccurrenceTicketInput, tx: unknown) {
    return openOccurrenceTicket(
      { tickets: this.tickets, chat: this.chat },
      input,
      tx,
    );
  }

  closeForOccurrence(input: CloseForOccurrenceInput, tx: unknown) {
    return closeTicketForOccurrence(this.tickets, input, tx);
  }

  recordSuperseded(
    input: { occurrenceId: string; businessId: string },
    tx: unknown,
  ) {
    return recordAuthorizationSuperseded(this.tickets, input, tx);
  }

  async ticketOf(
    occurrenceId: string,
    businessId: string,
  ): Promise<{ id: string; number: number } | null> {
    const found = await this.tickets.findByOccurrence(occurrenceId, businessId);

    return found ? { id: found.id, number: found.number } : null;
  }

  announce(input: Parameters<typeof announceTicket>[1]) {
    return announceTicket(this.tickets, input);
  }
}
