// uuid v7 like the columns' @default(uuid(7)): the id breaks created_at ties
// in creation order, as the (created_at, id) orderings expect.
import { v7 as uuidV7 } from "uuid";

import { Prisma } from "@prisma/client";

import type { ISupportTicketRepository } from "../ISupport-ticket-repository";
import type {
  AssignSupportTicketProps,
  CloseSupportTicketProps,
  CreateSupportTicketEventProps,
  CreateSupportTicketProps,
  ListSupportTicketsProps,
  OccurrenceAuthorizationState,
  SupportTicket,
  SupportTicketCounts,
  SupportTicketEvent,
  SupportTicketRow,
} from "../../dtos/support-ticket-dto";

import { InMemoryChatRepository } from "./in-memory-chat-repository";

const UNREAD_DISPLAY_CAP = 100;

function uniqueViolation(target: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    `Unique constraint failed on the fields: (\`${target}\`)`,
    { code: "P2002", clientVersion: "in-memory", meta: { target: [target] } },
  );
}

/**
 * The twin of SupportTicketRepository, over the chat twin's messages, reads
 * and directories so unread counts and previews derive from the same rows.
 *
 * Mirrors the database rules: number per company (counter), occurrenceId
 * unique, one OPEN DELIVERY ticket per delivery and one OPEN ROUTE ticket per
 * route (the partial unique indexes), client_submission_id unique per
 * company, version and reopened_count starting at 0.
 */
class InMemorySupportTicketRepository implements ISupportTicketRepository {
  public tickets: SupportTicket[] = [];
  public events: SupportTicketEvent[] = [];
  public reads: Array<{
    ticketId: string;
    userId: string;
    last_read_at: Date;
  }> = [];
  public counters = new Map<string, number>();

  /** Seeded by tests: the occurrence behind an OCCURRENCE ticket. */
  public occurrenceDirectory = new Map<
    string,
    {
      typeName: string;
      authorization_status: OccurrenceAuthorizationState;
      created_at: Date;
    }
  >();

  constructor(
    public chat: InMemoryChatRepository = new InMemoryChatRepository(),
  ) {}

  private violatesOpenUniqueness(
    candidate: SupportTicket,
    ignoreId?: string,
  ): string | null {
    for (const ticket of this.tickets) {
      if (ticket.id === ignoreId) continue;

      if (
        candidate.occurrenceId &&
        ticket.occurrenceId === candidate.occurrenceId
      ) {
        return "occurrenceId";
      }

      if (
        candidate.client_submission_id &&
        ticket.businessId === candidate.businessId &&
        ticket.client_submission_id === candidate.client_submission_id
      ) {
        return "client_submission_id";
      }

      if (candidate.status !== "OPEN" || ticket.status !== "OPEN") continue;

      if (
        candidate.kind === "DELIVERY" &&
        ticket.kind === "DELIVERY" &&
        candidate.deliveryId &&
        ticket.deliveryId === candidate.deliveryId
      ) {
        return "deliveryId";
      }

      if (
        candidate.kind === "ROUTE" &&
        ticket.kind === "ROUTE" &&
        candidate.routeId &&
        ticket.routeId === candidate.routeId
      ) {
        return "routeId";
      }
    }

    return null;
  }

  async create(props: CreateSupportTicketProps): Promise<SupportTicket> {
    const now = new Date();
    const next = (this.counters.get(props.businessId) ?? 0) + 1;

    const ticket: SupportTicket = {
      id: uuidV7(),
      number: next,
      kind: props.kind,
      status: "OPEN",
      subject: props.subject,
      businessId: props.businessId,
      threadId: props.threadId,
      driverId: props.driverId,
      deliveryId: props.deliveryId ?? null,
      occurrenceId: props.occurrenceId ?? null,
      routeId: props.routeId ?? null,
      opened_via: props.opened_via,
      openedById: props.openedById ?? null,
      assigneeId: null,
      assigned_at: null,
      first_staff_reply_at: null,
      closedById: null,
      closed_at: null,
      close_outcome: null,
      close_note: null,
      reopened_count: 0,
      last_message_at: null,
      last_driver_message_at: null,
      last_staff_message_at: null,
      version: 0,
      client_submission_id: props.client_submission_id ?? null,
      created_at: now,
      updated_at: now,
    };

    // Checked before the counter moves: the SQL rolls the number back with
    // the failed insert.
    const violation = this.violatesOpenUniqueness(ticket);
    if (violation) throw uniqueViolation(violation);

    this.counters.set(props.businessId, next);
    this.tickets.push(ticket);

    return { ...ticket };
  }

  private find(id: string, businessId: string): SupportTicket | undefined {
    return this.tickets.find(
      (ticket) => ticket.id === id && ticket.businessId === businessId,
    );
  }

  async findById(
    id: string,
    businessId: string,
  ): Promise<SupportTicket | null> {
    const found = this.find(id, businessId);

    return found ? { ...found } : null;
  }

  private toRow(ticket: SupportTicket): SupportTicketRow {
    const person = (id: string | null) =>
      id ? { id, name: this.chat.userDirectory.get(id)?.name ?? "" } : null;

    let driverUserId: string | null = null;

    for (const [userId, user] of this.chat.userDirectory) {
      if (user.driverId === ticket.driverId) {
        driverUserId = userId;
        break;
      }
    }

    const delivery = ticket.deliveryId
      ? this.chat.deliveryDirectory.get(ticket.deliveryId)
      : undefined;
    const route = ticket.routeId
      ? this.chat.routes.find((row) => row.id === ticket.routeId)
      : undefined;
    const occurrence = ticket.occurrenceId
      ? this.occurrenceDirectory.get(ticket.occurrenceId)
      : undefined;

    return {
      ...ticket,
      driver: {
        id: ticket.driverId,
        name: this.chat.driverDirectory.get(ticket.driverId)?.name ?? "",
      },
      driverUserId,
      delivery:
        ticket.deliveryId && delivery
          ? { id: ticket.deliveryId, ...delivery }
          : null,
      route: route
        ? { id: route.id, code: route.code, name: route.name }
        : null,
      occurrence:
        ticket.occurrenceId && occurrence
          ? { id: ticket.occurrenceId, ...occurrence }
          : null,
      assignee: person(ticket.assigneeId),
      openedBy: person(ticket.openedById),
      closedBy: person(ticket.closedById),
    };
  }

  async findRowById(
    id: string,
    businessId: string,
  ): Promise<SupportTicketRow | null> {
    const found = this.find(id, businessId);

    return found ? this.toRow(found) : null;
  }

  async findByOccurrence(occurrenceId: string, businessId: string) {
    const found = this.tickets.find(
      (ticket) =>
        ticket.occurrenceId === occurrenceId &&
        ticket.businessId === businessId,
    );

    return found ? { ...found } : null;
  }

  async findBySubmissionId(clientSubmissionId: string, businessId: string) {
    const found = this.tickets.find(
      (ticket) =>
        ticket.client_submission_id === clientSubmissionId &&
        ticket.businessId === businessId,
    );

    return found ? { ...found } : null;
  }

  private newestFirst(a: SupportTicket, b: SupportTicket): number {
    const byDate = b.created_at.getTime() - a.created_at.getTime();

    return byDate !== 0 ? byDate : b.id.localeCompare(a.id);
  }

  async findOpenForDelivery(
    deliveryId: string,
    businessId: string,
    kind: "OCCURRENCE" | "DELIVERY",
  ) {
    const found = this.tickets
      .filter(
        (ticket) =>
          ticket.deliveryId === deliveryId &&
          ticket.businessId === businessId &&
          ticket.kind === kind &&
          ticket.status === "OPEN",
      )
      .sort((a, b) => this.newestFirst(a, b))[0];

    return found ? { ...found } : null;
  }

  async findOpenForRoute(routeId: string, businessId: string) {
    const found = this.tickets.find(
      (ticket) =>
        ticket.routeId === routeId &&
        ticket.businessId === businessId &&
        ticket.kind === "ROUTE" &&
        ticket.status === "OPEN",
    );

    return found ? { ...found } : null;
  }

  private byLastMessage(a: SupportTicket, b: SupportTicket): number {
    const aTime = a.last_message_at?.getTime() ?? -Infinity;
    const bTime = b.last_message_at?.getTime() ?? -Infinity;

    if (aTime !== bTime) return bTime > aTime ? 1 : -1;

    return this.newestFirst(a, b);
  }

  async findLatestOpenDriverTicket(businessId: string, driverId: string) {
    const found = this.tickets
      .filter(
        (ticket) =>
          ticket.businessId === businessId &&
          ticket.driverId === driverId &&
          ticket.kind === "DRIVER" &&
          ticket.status === "OPEN",
      )
      .sort((a, b) => this.byLastMessage(a, b))[0];

    return found ? { ...found } : null;
  }

  async findLastStaffMessageTicket(
    threadId: string,
    driverUserId: string | null,
    before?: Date,
  ) {
    const message = this.chat.messages
      .filter(
        (row) =>
          row.threadId === threadId &&
          row.ticketId &&
          row.broadcast_id === null &&
          (!driverUserId || row.senderId !== driverUserId) &&
          (!before || row.created_at < before),
      )
      .sort((a, b) => {
        const byDate = b.created_at.getTime() - a.created_at.getTime();
        return byDate !== 0 ? byDate : b.id.localeCompare(a.id);
      })[0];

    const ticket = message?.ticketId
      ? this.tickets.find((row) => row.id === message.ticketId)
      : undefined;

    return ticket && message
      ? { ticket: { ...ticket }, at: message.created_at }
      : null;
  }

  async lockForUpdate(id: string, businessId: string) {
    return this.findById(id, businessId);
  }

  private mutate(
    id: string,
    change: (ticket: SupportTicket) => void,
  ): SupportTicket {
    const ticket = this.tickets.find((row) => row.id === id);

    if (!ticket) {
      throw new Prisma.PrismaClientKnownRequestError(
        "Record to update not found.",
        {
          code: "P2025",
          clientVersion: "in-memory",
        },
      );
    }

    change(ticket);
    ticket.updated_at = new Date();

    return { ...ticket };
  }

  async linkOccurrence(
    id: string,
    occurrenceId: string,
  ): Promise<SupportTicket> {
    const candidate = this.tickets.find((row) => row.id === id);

    if (candidate) {
      const violation = this.violatesOpenUniqueness(
        { ...candidate, kind: "OCCURRENCE", occurrenceId },
        id,
      );
      if (violation) throw uniqueViolation(violation);
    }

    return this.mutate(id, (ticket) => {
      ticket.kind = "OCCURRENCE";
      ticket.occurrenceId = occurrenceId;
      ticket.version += 1;
    });
  }

  async close(props: CloseSupportTicketProps): Promise<boolean> {
    const ticket = this.find(props.id, props.businessId);

    if (!ticket || ticket.status !== "OPEN") return false;

    this.mutate(ticket.id, (row) => {
      row.status = "CLOSED";
      row.closedById = props.closedById;
      row.closed_at = props.at;
      row.close_outcome = props.outcome;
      row.close_note = props.note;
      row.version += 1;
    });

    return true;
  }

  async assign(props: AssignSupportTicketProps): Promise<boolean> {
    const ticket = this.find(props.id, props.businessId);

    if (!ticket || ticket.status !== "OPEN") return false;

    if (
      props.expectedAssigneeId !== undefined &&
      ticket.assigneeId !== props.expectedAssigneeId
    ) {
      return false;
    }

    this.mutate(ticket.id, (row) => {
      row.assigneeId = props.assigneeId;
      row.assigned_at = props.assigneeId ? props.at : null;
      row.version += 1;
    });

    return true;
  }

  async autoAssign(id: string, assigneeId: string, at: Date): Promise<boolean> {
    const ticket = this.tickets.find((row) => row.id === id);

    if (!ticket || ticket.status !== "OPEN" || ticket.assigneeId !== null)
      return false;

    this.mutate(id, (row) => {
      row.assigneeId = assigneeId;
      row.assigned_at = at;
      row.version += 1;
    });

    return true;
  }

  async reopen(id: string, businessId: string): Promise<boolean> {
    const ticket = this.find(id, businessId);

    if (!ticket || ticket.status !== "CLOSED") return false;

    // The same partial unique index guards a reopen in Postgres.
    const violation = this.violatesOpenUniqueness(
      { ...ticket, status: "OPEN" },
      id,
    );
    if (violation) throw uniqueViolation(violation);

    this.mutate(id, (row) => {
      row.status = "OPEN";
      row.reopened_count += 1;
      row.closedById = null;
      row.closed_at = null;
      row.close_outcome = null;
      row.close_note = null;
      row.version += 1;
    });

    return true;
  }

  async touchOnMessage(props: {
    id: string;
    at: Date;
    side: "DRIVER" | "STAFF";
  }) {
    // GREATEST/LEAST semantics of the SQL: advance-only, NULL skipped.
    const later = (current: Date | null) =>
      current && current > props.at ? current : props.at;

    return this.mutate(props.id, (ticket) => {
      if (
        props.side === "STAFF" &&
        (ticket.first_staff_reply_at === null ||
          props.at < ticket.first_staff_reply_at)
      ) {
        ticket.first_staff_reply_at = props.at;
      }

      ticket.last_message_at = later(ticket.last_message_at);

      if (props.side === "DRIVER") {
        ticket.last_driver_message_at = later(ticket.last_driver_message_at);
      } else {
        ticket.last_staff_message_at = later(ticket.last_staff_message_at);
      }

      ticket.version += 1;
    });
  }

  async bumpVersion(id: string): Promise<SupportTicket> {
    return this.mutate(id, (ticket) => {
      ticket.version += 1;
    });
  }

  async addEvent(
    props: CreateSupportTicketEventProps,
  ): Promise<SupportTicketEvent> {
    const event: SupportTicketEvent = {
      id: uuidV7(),
      ticketId: props.ticketId,
      businessId: props.businessId,
      type: props.type,
      actor_kind: props.actor_kind,
      actorId: props.actorId ?? null,
      actor_name: props.actor_name ?? null,
      target_user_id: props.target_user_id ?? null,
      target_user_name: props.target_user_name ?? null,
      outcome: props.outcome ?? null,
      note: props.note ?? null,
      created_at: new Date(),
    };

    this.events.push(event);

    return { ...event };
  }

  async listEvents(ticketId: string, businessId: string, limit: number) {
    return this.events
      .filter(
        (event) =>
          event.ticketId === ticketId && event.businessId === businessId,
      )
      .sort((a, b) => {
        const byDate = a.created_at.getTime() - b.created_at.getTime();
        return byDate !== 0 ? byDate : a.id.localeCompare(b.id);
      })
      .slice(0, limit)
      .map((event) => ({ ...event }));
  }

  private matches(
    ticket: SupportTicket,
    props: ListSupportTicketsProps,
  ): boolean {
    if (ticket.businessId !== props.businessId) return false;
    if (props.driverId && ticket.driverId !== props.driverId) return false;
    if (props.status !== "ALL" && ticket.status !== props.status) return false;
    if (props.kind && ticket.kind !== props.kind) return false;
    if (props.filterDriverId && ticket.driverId !== props.filterDriverId)
      return false;
    if (props.deliveryId && ticket.deliveryId !== props.deliveryId)
      return false;
    if (props.routeId && ticket.routeId !== props.routeId) return false;
    if (props.occurrenceId && ticket.occurrenceId !== props.occurrenceId)
      return false;

    if (!props.driverId) {
      if (props.scope === "MINE" && ticket.assigneeId !== props.requesterUserId)
        return false;
      if (
        props.scope === "UNASSIGNED" &&
        (ticket.assigneeId !== null || ticket.status !== "OPEN")
      ) {
        return false;
      }
      if (props.scope === "PENDING_AUTHORIZATION") {
        const occurrence = ticket.occurrenceId
          ? this.occurrenceDirectory.get(ticket.occurrenceId)
          : undefined;
        if (occurrence?.authorization_status !== "PENDING") return false;
      }
    }

    const search = props.search?.trim().toLowerCase() ?? "";

    if (search) {
      const numberMatch = /^#?(\d{1,9})$/.exec(search);
      const row = this.toRow(ticket);

      const hit =
        (numberMatch !== null && ticket.number === Number(numberMatch[1])) ||
        ticket.subject.toLowerCase().includes(search) ||
        row.driver.name.toLowerCase().includes(search) ||
        (row.delivery?.recipient_name.toLowerCase().includes(search) ?? false);

      if (!hit) return false;
    }

    return true;
  }

  async list(props: ListSupportTicketsProps) {
    const scoped = this.tickets.filter((ticket) => this.matches(ticket, props));

    const sorted = [...scoped].sort((a, b) => {
      if (props.status === "CLOSED") {
        const aTime = a.closed_at?.getTime() ?? -Infinity;
        const bTime = b.closed_at?.getTime() ?? -Infinity;

        if (aTime !== bTime) return bTime > aTime ? 1 : -1;

        return b.id.localeCompare(a.id);
      }

      return this.byLastMessage(a, b);
    });

    return {
      data: sorted
        .slice((props.page - 1) * props.pageSize, props.page * props.pageSize)
        .map((ticket) => this.toRow(ticket)),
      total: scoped.length,
    };
  }

  private unreadOf(ticket: SupportTicket, requesterUserId: string): number {
    const ticketCursor = this.reads.find(
      (row) => row.ticketId === ticket.id && row.userId === requesterUserId,
    )?.last_read_at;
    const threadCursor = this.chat.reads.find(
      (row) =>
        row.threadId === ticket.threadId && row.userId === requesterUserId,
    )?.last_read_at;

    // GREATEST ignores nulls in Postgres.
    const cursors = [ticketCursor, threadCursor].filter(
      (value): value is Date => Boolean(value),
    );
    const cursor = cursors.length
      ? new Date(Math.max(...cursors.map((value) => value.getTime())))
      : null;

    const driverUserId = this.toRow(ticket).driverUserId;
    const requesterIsDriver = driverUserId === requesterUserId;

    const unread = this.chat.messages.filter((message) => {
      if (message.ticketId !== ticket.id) return false;
      if (cursor && message.created_at <= cursor) return false;

      return requesterIsDriver
        ? message.senderId !== requesterUserId
        : driverUserId !== null && message.senderId === driverUserId;
    }).length;

    return Math.min(unread, UNREAD_DISPLAY_CAP);
  }

  async counts({
    businessId,
    requesterUserId,
    driverId,
  }: {
    businessId: string;
    requesterUserId: string;
    driverId?: string;
  }): Promise<SupportTicketCounts> {
    const open = this.tickets.filter(
      (ticket) =>
        ticket.businessId === businessId &&
        ticket.status === "OPEN" &&
        (!driverId || ticket.driverId === driverId),
    );

    return {
      open: open.length,
      unassigned: open.filter((ticket) => ticket.assigneeId === null).length,
      mine: open.filter((ticket) => ticket.assigneeId === requesterUserId)
        .length,
      pendingAuthorization: open.filter(
        (ticket) =>
          ticket.occurrenceId !== null &&
          this.occurrenceDirectory.get(ticket.occurrenceId)
            ?.authorization_status === "PENDING",
      ).length,
      unreadOpen: Math.min(
        open.filter((ticket) => this.unreadOf(ticket, requesterUserId) > 0)
          .length,
        UNREAD_DISPLAY_CAP,
      ),
    };
  }

  async unreadCounts(ticketIds: string[], requesterUserId: string) {
    const result = new Map<string, number>();

    for (const id of ticketIds) {
      const ticket = this.tickets.find((row) => row.id === id);
      if (ticket) result.set(id, this.unreadOf(ticket, requesterUserId));
    }

    return result;
  }

  async lastMessages(ticketIds: string[]) {
    const result = new Map<
      string,
      {
        kind: "TEXT" | "IMAGE" | "AUDIO";
        body: string | null;
        sender: { id: string; name: string };
        created_at: Date;
      }
    >();

    for (const id of ticketIds) {
      const last = this.chat.messages
        .filter((message) => message.ticketId === id)
        .sort((a, b) => {
          const byDate = b.created_at.getTime() - a.created_at.getTime();
          return byDate !== 0 ? byDate : b.id.localeCompare(a.id);
        })[0];

      if (last) {
        result.set(id, {
          kind: last.kind,
          body: last.body,
          sender: {
            id: last.senderId,
            name: this.chat.userDirectory.get(last.senderId)?.name ?? "",
          },
          created_at: last.created_at,
        });
      }
    }

    return result;
  }

  async counterpartReadCursors(
    ticketIds: string[],
    driverUserId: string | null,
    viewerIsDriverSide: boolean,
  ): Promise<Map<string, Date>> {
    const result = new Map<string, Date>();

    if (!viewerIsDriverSide && !driverUserId) return result;

    for (const read of this.reads) {
      if (!ticketIds.includes(read.ticketId)) continue;

      const counterpart = viewerIsDriverSide
        ? read.userId !== driverUserId
        : read.userId === driverUserId;

      if (!counterpart) continue;

      const current = result.get(read.ticketId);

      if (!current || read.last_read_at > current)
        result.set(read.ticketId, read.last_read_at);
    }

    return result;
  }

  async markRead(ticketId: string, userId: string, at: Date): Promise<void> {
    const existing = this.reads.find(
      (row) => row.ticketId === ticketId && row.userId === userId,
    );

    if (!existing) {
      this.reads.push({ ticketId, userId, last_read_at: at });
      return;
    }

    if (existing.last_read_at < at) existing.last_read_at = at;
  }

  async findManyRows(ids: string[], businessId: string) {
    return this.tickets
      .filter(
        (ticket) => ids.includes(ticket.id) && ticket.businessId === businessId,
      )
      .map((ticket) => this.toRow(ticket));
  }

  /** Tests set it to stand for the migration record; none by default. */
  backfilledAt: Date | null = null;

  async ticketsBackfilledAt(): Promise<Date | null> {
    return this.backfilledAt;
  }

  async listUnticketedMessages(limit: number, since: Date) {
    return this.chat.messages
      .filter(
        (message) =>
          message.ticketId === null &&
          message.broadcast_id === null &&
          message.created_at >= since,
      )
      .sort((a, b) => {
        const byDate = a.created_at.getTime() - b.created_at.getTime();
        return byDate !== 0 ? byDate : a.id.localeCompare(b.id);
      })
      .slice(0, limit)
      .flatMap((message) => {
        const thread = this.chat.threads.find(
          (row) => row.id === message.threadId,
        );

        return thread
          ? [
              {
                id: message.id,
                threadId: message.threadId,
                businessId: thread.businessId,
                driverId: thread.driverId,
                senderId: message.senderId,
                deliveryId: message.deliveryId,
                routeId: message.routeId,
                created_at: message.created_at,
              },
            ]
          : [];
      });
  }

  async attachMessage(messageId: string, ticketId: string): Promise<boolean> {
    const message = this.chat.messages.find((row) => row.id === messageId);

    if (!message || message.ticketId !== null) return false;

    message.ticketId = ticketId;

    return true;
  }
}

export { InMemorySupportTicketRepository };
