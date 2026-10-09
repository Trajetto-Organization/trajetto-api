import type {
  OccurrenceAuthorizationState,
  SupportTicketKind,
  SupportTicketOpenedVia,
  SupportTicketOutcome,
  SupportTicketRow,
  SupportTicketStatus,
} from "../../dtos/support-ticket-dto";

import { closeOutcomesFor, waitingOn } from "./ticket-rules";
import { buildChatBodyPreview } from "./chat-presenter";

/** How long a request waits before the administrators are told (decision 6.3). */
const AUTHORIZATION_ESCALATION_MS = 10 * 60 * 1000;

interface TicketLastMessage {
  kind: "TEXT" | "IMAGE" | "AUDIO";
  body: string | null;
  sender: { id: string; name: string };
  created_at: Date;
}

/** The wire shape every ticket endpoint and event answers with (design §4.1). */
interface TicketSummary {
  id: string;
  number: number;
  kind: SupportTicketKind;
  status: SupportTicketStatus;
  subject: string;
  version: number;
  threadId: string;
  driver: { id: string; name: string };
  delivery: { id: string; recipient_name: string; status: string } | null;
  route: { id: string; code: number; name: string | null } | null;
  occurrence: {
    id: string;
    typeName: string;
    authorization_status: OccurrenceAuthorizationState;
    escalates_at: string | null;
  } | null;
  assignee: { id: string; name: string } | null;
  waitingOn: "STAFF" | "DRIVER" | null;
  opened_via: SupportTicketOpenedVia;
  openedBy: { id: string; name: string } | null;
  closedBy: { id: string; name: string } | null;
  closed_at: string | null;
  close_outcome: SupportTicketOutcome | null;
  close_note: string | null;
  closeOutcomes: Array<Exclude<SupportTicketOutcome, "MIGRATED">>;
  last_message_at: string | null;
  lastMessage: {
    kind: "TEXT" | "IMAGE" | "AUDIO";
    preview: string | null;
    sender: { id: string; name: string };
  } | null;
  unreadCount: number;
  created_at: string;
}

function presentTicket(
  row: SupportTicketRow,
  extras: { unreadCount?: number; lastMessage?: TicketLastMessage | null } = {},
): TicketSummary {
  const authorization = row.occurrence?.authorization_status ?? null;

  return {
    id: row.id,
    number: row.number,
    kind: row.kind,
    status: row.status,
    subject: row.subject,
    version: row.version,
    threadId: row.threadId,
    driver: row.driver,
    delivery: row.delivery,
    route: row.route,
    occurrence: row.occurrence
      ? {
          id: row.occurrence.id,
          typeName: row.occurrence.typeName,
          authorization_status: row.occurrence.authorization_status,
          escalates_at:
            row.occurrence.authorization_status === "PENDING"
              ? new Date(
                  row.occurrence.created_at.getTime() + AUTHORIZATION_ESCALATION_MS,
                ).toISOString()
              : null,
        }
      : null,
    assignee: row.assignee,
    waitingOn: waitingOn(row),
    opened_via: row.opened_via,
    openedBy: row.openedBy,
    closedBy: row.closedBy,
    closed_at: row.closed_at?.toISOString() ?? null,
    close_outcome: row.close_outcome,
    close_note: row.close_note,
    closeOutcomes: closeOutcomesFor(row.status, authorization),
    last_message_at: row.last_message_at?.toISOString() ?? null,
    lastMessage: extras.lastMessage
      ? {
          kind: extras.lastMessage.kind,
          preview: buildChatBodyPreview(extras.lastMessage.body),
          sender: extras.lastMessage.sender,
        }
      : null,
    unreadCount: extras.unreadCount ?? 0,
    created_at: row.created_at.toISOString(),
  };
}

/**
 * What the driver's phone hears about a ticket: number, subject, status,
 * outcome and note. Never who is handling it inside the company — the app
 * labels the whole tower as "a base" (decision of slice 6).
 */
function driverTicketView(ticket: TicketSummary) {
  return {
    id: ticket.id,
    number: ticket.number,
    kind: ticket.kind,
    status: ticket.status,
    subject: ticket.subject,
    version: ticket.version,
    delivery: ticket.delivery,
    route: ticket.route,
    occurrence: ticket.occurrence
      ? {
          id: ticket.occurrence.id,
          typeName: ticket.occurrence.typeName,
          authorization_status: ticket.occurrence.authorization_status,
        }
      : null,
    closed_at: ticket.closed_at,
    close_outcome: ticket.close_outcome,
    close_note: ticket.close_note,
    created_at: ticket.created_at,
  };
}

type DriverTicketView = ReturnType<typeof driverTicketView>;

export { presentTicket, driverTicketView, AUTHORIZATION_ESCALATION_MS };
export type { TicketSummary, TicketLastMessage, DriverTicketView };
