import type {
  OccurrenceAuthorizationState,
  SupportTicket,
  SupportTicketOutcome,
} from "../../dtos/support-ticket-dto";

/**
 * Pure rules of the support tickets (decision 14.5). Pure so the HTTP use
 * cases, the occurrence report and the tests share one decision.
 */

/** The longest subject the column is meant to hold. */
const TICKET_SUBJECT_MAX = 160;

/**
 * A message from a client that does not know tickets is a reply to the
 * tower's last message for this long (product parameter, not measured).
 */
const LEGACY_REPLY_WINDOW_MS = 30 * 60 * 1000;

function truncateSubject(subject: string): string {
  const clean = subject.replace(/\s+/g, " ").trim();

  return clean.length > TICKET_SUBJECT_MAX
    ? `${clean.slice(0, TICKET_SUBJECT_MAX - 1)}…`
    : clean;
}

/** "{tipo} — {destinatário}", the occurrence ticket's subject. */
function occurrenceTicketSubject(
  typeName: string,
  recipientName: string,
): string {
  return truncateSubject(`${typeName} — ${recipientName}`);
}

interface OccurrenceTicketInput {
  authorizationStatus: OccurrenceAuthorizationState;
  byDriver: boolean;
  category: "DELIVERED" | "NOT_DELIVERED" | "PAUSE";
  isSystem: boolean;
}

/**
 * Whether an occurrence report opens a ticket on its own (design §3.1).
 *
 * A request waiting for the tower always does: somebody has to answer. A
 * driver's problem report does. A delivery ("Entrega normal") or a pause does
 * not, or every completed stop would flood the tower. A panel report that
 * applied at once is already handled by its author.
 */
function shouldOpenTicketForOccurrence(input: OccurrenceTicketInput): boolean {
  if (input.isSystem) return false;

  if (input.authorizationStatus === "PENDING") return true;

  if (input.authorizationStatus === "SUPERSEDED") return false;

  return input.byDriver && input.category === "NOT_DELIVERED";
}

/**
 * What "Encerrar" may answer (design §4.4): approve or deny while the
 * occurrence waits for the tower, resolve otherwise, nothing once closed.
 */
function closeOutcomesFor(
  status: SupportTicket["status"],
  authorizationStatus: OccurrenceAuthorizationState | null,
): Array<Exclude<SupportTicketOutcome, "MIGRATED">> {
  if (status === "CLOSED") return [];

  return authorizationStatus === "PENDING"
    ? ["APPROVED", "DENIED"]
    : ["RESOLVED"];
}

type CloseOutcomeProblem =
  | "SUPPORT_TICKET_AUTHORIZATION_PENDING"
  | "SUPPORT_TICKET_NOT_AUTHORIZATION";

/** Which refusal an outcome gets against what the ticket allows, or null. */
function closeOutcomeProblem(
  authorizationStatus: OccurrenceAuthorizationState | null,
  outcome: Exclude<SupportTicketOutcome, "MIGRATED">,
): CloseOutcomeProblem | null {
  const pending = authorizationStatus === "PENDING";

  if (pending && outcome === "RESOLVED")
    return "SUPPORT_TICKET_AUTHORIZATION_PENDING";

  if (!pending && outcome !== "RESOLVED")
    return "SUPPORT_TICKET_NOT_AUTHORIZATION";

  return null;
}

/**
 * Whose turn it is, derived from the last message side — never a column that
 * could disagree with the messages.
 */
function waitingOn(
  ticket: Pick<
    SupportTicket,
    "status" | "last_driver_message_at" | "last_staff_message_at"
  >,
): "STAFF" | "DRIVER" | null {
  if (ticket.status !== "OPEN") return null;

  const driver = ticket.last_driver_message_at?.getTime() ?? null;
  const staff = ticket.last_staff_message_at?.getTime() ?? null;

  if (driver === null && staff === null) return null;
  if (staff === null) return "STAFF";
  if (driver === null) return "DRIVER";

  return driver > staff ? "STAFF" : "DRIVER";
}

interface LegacyRoutingInput {
  /** The ticket of the tower's latest message to this driver, if recent. */
  recentStaffTicket: { id: string; status: "OPEN" | "CLOSED"; at: Date } | null;
  now: Date;
  deliveryId: string | null;
  /** The route the sender named. */
  explicitRouteId: string | null;
  /** The route the server derived (the one he is running). */
  derivedRouteId: string | null;
  /** The driver's most recent OPEN general ticket. */
  latestOpenDriverTicketId: string | null;
}

type LegacyRoute =
  | { target: "TICKET"; ticketId: string }
  | { target: "DELIVERY"; deliveryId: string }
  | { target: "ROUTE"; routeId: string }
  | { target: "NEW_DRIVER" };

/**
 * Where a message from a client that does not know tickets lands (§4.9):
 * a reply to the tower's recent message, the delivery's ticket, the route's,
 * the driver's open general ticket, or a new one.
 */
function routeLegacyMessage(input: LegacyRoutingInput): LegacyRoute {
  const recent = input.recentStaffTicket;

  if (
    recent &&
    recent.status === "OPEN" &&
    !input.deliveryId &&
    !input.explicitRouteId &&
    input.now.getTime() - recent.at.getTime() <= LEGACY_REPLY_WINDOW_MS
  ) {
    // A route derived from "the route he is running" is not a citation.
    return { target: "TICKET", ticketId: recent.id };
  }

  if (input.deliveryId)
    return { target: "DELIVERY", deliveryId: input.deliveryId };

  const routeId = input.explicitRouteId ?? input.derivedRouteId;

  if (routeId) return { target: "ROUTE", routeId };

  if (input.latestOpenDriverTicketId) {
    return { target: "TICKET", ticketId: input.latestOpenDriverTicketId };
  }

  return { target: "NEW_DRIVER" };
}

/** Last message side of a sender, for the ticket's ordering columns. */
function messageSide(senderIsDriver: boolean): "DRIVER" | "STAFF" {
  return senderIsDriver ? "DRIVER" : "STAFF";
}

/** The legacy ticket accepts writes only while still open (esquema §6). */
function canReopen(ticket: Pick<SupportTicket, "kind" | "status">): boolean {
  return ticket.status === "CLOSED" && ticket.kind !== "LEGACY";
}

export {
  TICKET_SUBJECT_MAX,
  LEGACY_REPLY_WINDOW_MS,
  truncateSubject,
  occurrenceTicketSubject,
  shouldOpenTicketForOccurrence,
  closeOutcomesFor,
  closeOutcomeProblem,
  waitingOn,
  routeLegacyMessage,
  messageSide,
  canReopen,
};
export type {
  OccurrenceTicketInput,
  LegacyRoutingInput,
  LegacyRoute,
  CloseOutcomeProblem,
};
