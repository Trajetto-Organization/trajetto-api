import type { IChatRepository } from "../../repositories/IChat-repository";
import type { ISupportTicketRepository } from "../../repositories/ISupport-ticket-repository";
import type {
  SupportTicket,
  SupportTicketOpenedVia,
} from "../../dtos/support-ticket-dto";

import { isUniqueViolation } from "@/shared/http/idempotency-key";

import { truncateSubject } from "./ticket-rules";
import { announceTicket } from "./ticket-operations";

/**
 * Get-or-create of the tickets about a delivery, a route or a driver
 * (design §3.2). Concurrency is settled by the database: the partial unique
 * index on the OPEN DELIVERY/ROUTE ticket turns the loser of a race into a
 * P2002, and the loser re-reads the winner.
 */

interface TicketFactoryDeps {
  tickets: ISupportTicketRepository;
  chat: IChatRepository;
}

interface OpenedBy {
  via: SupportTicketOpenedVia;
  userId: string | null;
  actorKind: "USER" | "DRIVER_APP" | "SYSTEM";
  actorName: string | null;
}

interface TicketResolution {
  ticket: SupportTicket;
  created: boolean;
}

function deliverySubject(recipientName: string): string {
  return truncateSubject(`Entrega — ${recipientName}`);
}

function routeSubject(route: { code: number; name: string | null }): string {
  return truncateSubject(route.name ? `Rota ${route.code} · ${route.name}` : `Rota ${route.code}`);
}

function driverSubject(driverName: string): string {
  return truncateSubject(`Conversa com ${driverName}`);
}

async function recordOpened(
  deps: TicketFactoryDeps,
  ticket: SupportTicket,
  opened: OpenedBy,
): Promise<void> {
  await deps.tickets.addEvent({
    ticketId: ticket.id,
    businessId: ticket.businessId,
    type: "OPENED",
    actor_kind: opened.actorKind,
    actorId: opened.userId,
    actor_name: opened.actorName,
  });
}

const HANDOVER_NOTE = {
  DELIVERY: "Encerrado automaticamente: a entrega passou para outro motorista.",
  ROUTE: "Encerrado automaticamente: a rota passou para outro motorista.",
} as const;

/**
 * A DELIVERY/ROUTE ticket lives in the conversation of the driver it was
 * opened with. After a reassignment (14.7) the previous driver's open ticket
 * still holds the partial unique slot of the delivery/route; reusing it would
 * put the new driver's words in someone else's ticket and send the tower's
 * replies to the wrong phone. The system closes it (with a trail entry) so
 * the new driver gets his own. Runs outside any transaction: the close is
 * committed when it returns, so the announcement is post-commit.
 */
async function retireHandedOverTicket(
  deps: TicketFactoryDeps,
  ticket: SupportTicket,
  scope: keyof typeof HANDOVER_NOTE,
): Promise<void> {
  const note = HANDOVER_NOTE[scope];

  const closed = await deps.tickets.close({
    id: ticket.id,
    businessId: ticket.businessId,
    closedById: null,
    outcome: "RESOLVED",
    note,
    at: new Date(),
  });

  // Somebody else closed it first: their trail entry stands.
  if (!closed) return;

  await deps.tickets.addEvent({
    ticketId: ticket.id,
    businessId: ticket.businessId,
    type: "CLOSED",
    actor_kind: "SYSTEM",
    outcome: "RESOLVED",
    note,
  });

  await announceTicket(deps.tickets, {
    ticketId: ticket.id,
    businessId: ticket.businessId,
    type: "ticket.closed",
    actor: null,
  });
}

/**
 * The delivery's open OCCURRENCE ticket, else its open DELIVERY one, else a
 * new one. `holderDriverId` is who holds the delivery now: only the holder
 * proves a handover. Any other driver (a stale chip in the panel, an old
 * message filed by the repair) gets his own still-open ticket about it or
 * `null` (the caller files the message elsewhere); the holder's live ticket
 * is never touched on his behalf.
 */
async function resolveDeliveryTicket(
  deps: TicketFactoryDeps,
  input: {
    businessId: string;
    driverId: string;
    holderDriverId: string | null;
    deliveryId: string;
    recipientName: string;
    opened: OpenedBy;
    clientSubmissionId?: string | null;
  },
): Promise<TicketResolution | null> {
  const occurrence = await deps.tickets.findOpenForDelivery(
    input.deliveryId,
    input.businessId,
    "OCCURRENCE",
  );

  if (occurrence && occurrence.driverId === input.driverId) {
    return { ticket: occurrence, created: false };
  }

  const existing = await deps.tickets.findOpenForDelivery(
    input.deliveryId,
    input.businessId,
    "DELIVERY",
  );

  if (existing && existing.driverId === input.driverId) {
    return { ticket: existing, created: false };
  }

  if (input.holderDriverId !== input.driverId) return null;

  if (existing) await retireHandedOverTicket(deps, existing, "DELIVERY");

  const thread = await deps.chat.getOrCreateThread(input.businessId, input.driverId);

  try {
    const ticket = await deps.tickets.create({
      businessId: input.businessId,
      threadId: thread.id,
      driverId: input.driverId,
      kind: "DELIVERY",
      subject: deliverySubject(input.recipientName),
      deliveryId: input.deliveryId,
      opened_via: input.opened.via,
      openedById: input.opened.userId,
      client_submission_id: input.clientSubmissionId ?? null,
    });

    await recordOpened(deps, ticket, input.opened);

    return { ticket, created: true };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;

    const winner = await deps.tickets.findOpenForDelivery(
      input.deliveryId,
      input.businessId,
      "DELIVERY",
    );

    // Only a twin request of this same driver may answer with the winner.
    if (!winner || winner.driverId !== input.driverId) throw error;

    return { ticket: winner, created: false };
  }
}

/**
 * The route's open ROUTE ticket, else a new one. As with a delivery, only
 * the driver the route is assigned to now (`route.driverId`) proves a
 * handover; anyone else gets his own still-open ticket about it or `null`.
 */
async function resolveRouteTicket(
  deps: TicketFactoryDeps,
  input: {
    businessId: string;
    driverId: string;
    route: { id: string; driverId: string; code: number; name: string | null };
    opened: OpenedBy;
    clientSubmissionId?: string | null;
  },
): Promise<TicketResolution | null> {
  const existing = await deps.tickets.findOpenForRoute(input.route.id, input.businessId);

  if (existing && existing.driverId === input.driverId) {
    return { ticket: existing, created: false };
  }

  if (input.route.driverId !== input.driverId) return null;

  if (existing) await retireHandedOverTicket(deps, existing, "ROUTE");

  const thread = await deps.chat.getOrCreateThread(input.businessId, input.driverId);

  try {
    const ticket = await deps.tickets.create({
      businessId: input.businessId,
      threadId: thread.id,
      driverId: input.driverId,
      kind: "ROUTE",
      subject: routeSubject(input.route),
      routeId: input.route.id,
      opened_via: input.opened.via,
      openedById: input.opened.userId,
      client_submission_id: input.clientSubmissionId ?? null,
    });

    await recordOpened(deps, ticket, input.opened);

    return { ticket, created: true };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;

    const winner = await deps.tickets.findOpenForRoute(input.route.id, input.businessId);

    if (!winner || winner.driverId !== input.driverId) throw error;

    return { ticket: winner, created: false };
  }
}

/** A new general ticket with the driver (several may be open). */
async function createDriverTicket(
  deps: TicketFactoryDeps,
  input: {
    businessId: string;
    driverId: string;
    subject: string;
    opened: OpenedBy;
    clientSubmissionId?: string | null;
    occurrence?: { id: string; deliveryId: string } | null;
  },
): Promise<SupportTicket> {
  const thread = await deps.chat.getOrCreateThread(input.businessId, input.driverId);

  const ticket = await deps.tickets.create({
    businessId: input.businessId,
    threadId: thread.id,
    driverId: input.driverId,
    kind: input.occurrence ? "OCCURRENCE" : "DRIVER",
    subject: truncateSubject(input.subject),
    deliveryId: input.occurrence?.deliveryId ?? null,
    occurrenceId: input.occurrence?.id ?? null,
    opened_via: input.opened.via,
    openedById: input.opened.userId,
    client_submission_id: input.clientSubmissionId ?? null,
  });

  await recordOpened(deps, ticket, input.opened);

  return ticket;
}

export {
  resolveDeliveryTicket,
  resolveRouteTicket,
  createDriverTicket,
  deliverySubject,
  routeSubject,
  driverSubject,
};
export type { TicketFactoryDeps, OpenedBy, TicketResolution };
