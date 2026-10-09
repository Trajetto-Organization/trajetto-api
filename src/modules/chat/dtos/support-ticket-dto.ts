/**
 * Support tickets (decision 14.5, docs/desenho/tickets-de-atendimento.md).
 *
 * The ticket is the traceable SUBJECT; the per-driver ChatThread stays the
 * physical channel (cursors, presence, socket room). Every message outside a
 * mass notice belongs to one ticket.
 */

type SupportTicketKind = "OCCURRENCE" | "DELIVERY" | "ROUTE" | "DRIVER" | "LEGACY";

type SupportTicketStatus = "OPEN" | "CLOSED";

type SupportTicketOpenedVia =
  | "OCCURRENCE_REPORT"
  | "DRIVER_APP"
  | "PANEL"
  | "LEGACY_ROUTING"
  | "MIGRATION";

type SupportTicketOutcome = "RESOLVED" | "APPROVED" | "DENIED" | "MIGRATED";

type SupportTicketEventType =
  | "OPENED"
  | "ASSIGNED"
  | "UNASSIGNED"
  | "CLOSED"
  | "REOPENED"
  | "OCCURRENCE_LINKED"
  | "AUTHORIZATION_DECIDED"
  | "AUTHORIZATION_SUPERSEDED";

type SupportTicketActorKind = "USER" | "DRIVER_APP" | "SYSTEM";

type OccurrenceAuthorizationState =
  | "NOT_REQUIRED"
  | "PENDING"
  | "APPROVED"
  | "DENIED"
  | "SUPERSEDED";

/** The row, exactly as stored. */
interface SupportTicket {
  id: string;
  number: number;
  kind: SupportTicketKind;
  status: SupportTicketStatus;
  subject: string;
  businessId: string;
  threadId: string;
  driverId: string;
  deliveryId: string | null;
  occurrenceId: string | null;
  routeId: string | null;
  opened_via: SupportTicketOpenedVia;
  openedById: string | null;
  assigneeId: string | null;
  assigned_at: Date | null;
  first_staff_reply_at: Date | null;
  closedById: string | null;
  closed_at: Date | null;
  close_outcome: SupportTicketOutcome | null;
  close_note: string | null;
  reopened_count: number;
  last_message_at: Date | null;
  last_driver_message_at: Date | null;
  last_staff_message_at: Date | null;
  version: number;
  client_submission_id: string | null;
  created_at: Date;
  updated_at: Date;
}

interface PersonRef {
  id: string;
  name: string;
}

/** The row plus what the lists draw, resolved in the repository. */
interface SupportTicketRow extends SupportTicket {
  driver: PersonRef;
  /** The driver's app account; null when he has none. */
  driverUserId: string | null;
  delivery: { id: string; recipient_name: string; status: string } | null;
  route: { id: string; code: number; name: string | null } | null;
  occurrence: {
    id: string;
    typeName: string;
    authorization_status: OccurrenceAuthorizationState;
    created_at: Date;
  } | null;
  assignee: PersonRef | null;
  openedBy: PersonRef | null;
  closedBy: PersonRef | null;
}

interface CreateSupportTicketProps {
  businessId: string;
  threadId: string;
  driverId: string;
  kind: SupportTicketKind;
  subject: string;
  deliveryId?: string | null;
  occurrenceId?: string | null;
  routeId?: string | null;
  opened_via: SupportTicketOpenedVia;
  openedById?: string | null;
  client_submission_id?: string | null;
}

interface SupportTicketEvent {
  id: string;
  ticketId: string;
  businessId: string;
  type: SupportTicketEventType;
  actor_kind: SupportTicketActorKind;
  actorId: string | null;
  actor_name: string | null;
  target_user_id: string | null;
  target_user_name: string | null;
  outcome: SupportTicketOutcome | null;
  note: string | null;
  created_at: Date;
}

interface CreateSupportTicketEventProps {
  ticketId: string;
  businessId: string;
  type: SupportTicketEventType;
  actor_kind: SupportTicketActorKind;
  actorId?: string | null;
  actor_name?: string | null;
  target_user_id?: string | null;
  target_user_name?: string | null;
  outcome?: SupportTicketOutcome | null;
  note?: string | null;
}

type SupportTicketStatusFilter = "OPEN" | "CLOSED" | "ALL";
type SupportTicketScope = "ALL" | "MINE" | "UNASSIGNED" | "PENDING_AUTHORIZATION";

interface ListSupportTicketsProps {
  businessId: string;
  requesterUserId: string;
  /** Driver token: only his tickets. */
  driverId?: string;
  status: SupportTicketStatusFilter;
  scope: SupportTicketScope;
  kind?: SupportTicketKind;
  filterDriverId?: string;
  deliveryId?: string;
  routeId?: string;
  occurrenceId?: string;
  search?: string;
  page: number;
  pageSize: number;
}

interface SupportTicketCounts {
  open: number;
  unassigned: number;
  mine: number;
  pendingAuthorization: number;
  /** Open tickets with something the requester has not read. */
  unreadOpen: number;
}

interface CloseSupportTicketProps {
  id: string;
  businessId: string;
  closedById: string | null;
  outcome: SupportTicketOutcome;
  note: string | null;
  at: Date;
}

interface AssignSupportTicketProps {
  id: string;
  businessId: string;
  assigneeId: string | null;
  /**
   * Conditional write: only when the current assignee is this one.
   * `undefined` = unconditional.
   */
  expectedAssigneeId?: string | null;
  at: Date;
}

export type {
  SupportTicketKind,
  SupportTicketStatus,
  SupportTicketOpenedVia,
  SupportTicketOutcome,
  SupportTicketEventType,
  SupportTicketActorKind,
  OccurrenceAuthorizationState,
  SupportTicket,
  SupportTicketRow,
  PersonRef,
  CreateSupportTicketProps,
  SupportTicketEvent,
  CreateSupportTicketEventProps,
  SupportTicketStatusFilter,
  SupportTicketScope,
  ListSupportTicketsProps,
  SupportTicketCounts,
  CloseSupportTicketProps,
  AssignSupportTicketProps,
};
