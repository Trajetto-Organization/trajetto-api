import type {
  AssignSupportTicketProps,
  CloseSupportTicketProps,
  CreateSupportTicketEventProps,
  CreateSupportTicketProps,
  ListSupportTicketsProps,
  SupportTicket,
  SupportTicketCounts,
  SupportTicketEvent,
  SupportTicketRow,
} from "../dtos/support-ticket-dto";

/**
 * Support tickets (decision 14.5). Every read takes the company: "of another
 * company" never leaves the repository as a row. Writes accept the caller's
 * transaction (`tx`), so a ticket commits with the occurrence, the decision
 * or the message that caused it.
 */
interface ISupportTicketRepository {
  /**
   * Allocates the company's next number (counter row, ON CONFLICT … RETURNING)
   * and inserts. A second OPEN DELIVERY/ROUTE ticket of the same delivery or
   * route, a second ticket of one occurrence or a reused key throw P2002.
   */
  create: (props: CreateSupportTicketProps, tx?: unknown) => Promise<SupportTicket>;

  findById: (id: string, businessId: string, tx?: unknown) => Promise<SupportTicket | null>;

  /** The row with its names, for the lists and the detail. */
  findRowById: (id: string, businessId: string) => Promise<SupportTicketRow | null>;

  findByOccurrence: (
    occurrenceId: string,
    businessId: string,
    tx?: unknown,
  ) => Promise<SupportTicket | null>;

  findBySubmissionId: (
    clientSubmissionId: string,
    businessId: string,
  ) => Promise<SupportTicket | null>;

  /** The OPEN ticket of this kind for the delivery (newest first). */
  findOpenForDelivery: (
    deliveryId: string,
    businessId: string,
    kind: "OCCURRENCE" | "DELIVERY",
    tx?: unknown,
  ) => Promise<SupportTicket | null>;

  findOpenForRoute: (routeId: string, businessId: string) => Promise<SupportTicket | null>;

  /** The driver's most recent OPEN general (DRIVER) ticket. */
  findLatestOpenDriverTicket: (
    businessId: string,
    driverId: string,
  ) => Promise<SupportTicket | null>;

  /**
   * The ticket of the newest message in this thread NOT sent by the driver's
   * user, with when it was sent. Null when there is none. `before` looks
   * only at messages older than that instant (the repair files an old
   * message by what the tower had said up to then).
   */
  findLastStaffMessageTicket: (
    threadId: string,
    driverUserId: string | null,
    before?: Date,
  ) => Promise<{ ticket: SupportTicket; at: Date } | null>;

  /** SELECT … FOR UPDATE inside the caller's transaction. */
  lockForUpdate: (id: string, businessId: string, tx: unknown) => Promise<SupportTicket | null>;

  /** An OPEN DELIVERY ticket becomes this occurrence's (kind OCCURRENCE). */
  linkOccurrence: (id: string, occurrenceId: string, tx?: unknown) => Promise<SupportTicket>;

  /** Conditional on OPEN. False when nothing changed. */
  close: (props: CloseSupportTicketProps, tx?: unknown) => Promise<boolean>;

  /** Conditional on `expectedAssigneeId` (when given) and on OPEN. */
  assign: (props: AssignSupportTicketProps, tx?: unknown) => Promise<boolean>;

  /** First reply wins: only while nobody is assigned. */
  autoAssign: (id: string, assigneeId: string, at: Date, tx?: unknown) => Promise<boolean>;

  /** CLOSED → OPEN, reopened_count + 1, closed_* cleared. */
  reopen: (id: string, businessId: string, tx?: unknown) => Promise<boolean>;

  /**
   * last_*_message_at and first_staff_reply_at, with the message, and
   * version + 1. Advance-only (GREATEST; LEAST for the first reply): a
   * repaired older message never moves the ticket back in the list order.
   */
  touchOnMessage: (
    props: { id: string; at: Date; side: "DRIVER" | "STAFF" },
    tx?: unknown,
  ) => Promise<SupportTicket>;

  /** version + 1: a trail-only change (a supersede) still orders events. */
  bumpVersion: (id: string, tx?: unknown) => Promise<SupportTicket>;

  addEvent: (props: CreateSupportTicketEventProps, tx?: unknown) => Promise<SupportTicketEvent>;

  /** In order, at most `limit`. */
  listEvents: (ticketId: string, businessId: string, limit: number) => Promise<SupportTicketEvent[]>;

  list: (props: ListSupportTicketsProps) => Promise<{ data: SupportTicketRow[]; total: number }>;

  counts: (props: {
    businessId: string;
    requesterUserId: string;
    driverId?: string;
  }) => Promise<SupportTicketCounts>;

  /** Unread per ticket for the requester (capped like the chat badge). */
  unreadCounts: (
    ticketIds: string[],
    requesterUserId: string,
    viewerIsDriverSide: boolean,
  ) => Promise<Map<string, number>>;

  /** The newest message of each ticket. */
  lastMessages: (ticketIds: string[]) => Promise<
    Map<
      string,
      {
        kind: "TEXT" | "IMAGE" | "AUDIO";
        body: string | null;
        sender: { id: string; name: string };
        created_at: Date;
      }
    >
  >;

  /**
   * The OTHER side's newest read cursor on each ticket: any agent's (the
   * company reads as a team) when the viewer is the driver, the driver's
   * own otherwise. The double check of a ticket's message is the later of
   * this and the thread cursor. Tickets nobody on that side read are absent.
   */
  counterpartReadCursors: (
    ticketIds: string[],
    driverUserId: string | null,
    viewerIsDriverSide: boolean,
  ) => Promise<Map<string, Date>>;

  /** Advances (never rewinds) the requester's cursor on the ticket. */
  markRead: (ticketId: string, userId: string, at: Date) => Promise<void>;

  /** The tickets cited on a page of messages (separators of the feed). */
  findManyRows: (ids: string[], businessId: string) => Promise<SupportTicketRow[]>;

  /**
   * Non-mass messages written without a ticket (by the previous image during
   * a rolling deploy), created at or after `since`, oldest first, for the
   * repair job. The bound keeps the scan off the ever-growing mass notices,
   * which stay ticketless forever.
   */
  listUnticketedMessages: (limit: number, since: Date) => Promise<
    Array<{
      id: string;
      threadId: string;
      businessId: string;
      driverId: string;
      senderId: string;
      deliveryId: string | null;
      routeId: string | null;
      created_at: Date;
    }>
  >;

  /**
   * When this database ran the backfill that filed every older message
   * (the migration's `finished_at`); null when it has no record of it.
   */
  ticketsBackfilledAt: () => Promise<Date | null>;

  /** Puts a ticketless message in a ticket (repair job). */
  attachMessage: (messageId: string, ticketId: string, tx?: unknown) => Promise<boolean>;
}

export type { ISupportTicketRepository };
