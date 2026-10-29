import { Prisma } from "@prisma/client";

import database from "@/../infra/database";
import { escapeLikePattern } from "@/shared/utils/like-pattern";
import {
  DELIVERY_SEARCH_TEXT,
  SEARCH_FIELD_SEPARATOR,
  SEARCH_PREFILTER_CAP,
  SEARCH_PREFILTER_MIN_LENGTH,
} from "@/modules/delivery/repositories/delivery-search";

/** The joined arms of the inbox search, resolved to ids (resolveSearchMatches). */
interface TicketSearchMatches {
  deliveryIds: string[];
  driverIds: string[];
}

import type { ISupportTicketRepository } from "./ISupport-ticket-repository";
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

type Client = Prisma.TransactionClient | typeof database;

/** Mirrors the chat badge: past this the interface only says "99+". */
const UNREAD_DISPLAY_CAP = 100;

/** The migration that filed every message written before tickets existed. */
const TICKETS_BACKFILL_MIGRATION = "20261005120600_support_tickets_backfill";

const rowInclude = {
  thread: {
    select: {
      driver: {
        select: { id: true, name: true, User: { select: { id: true } } },
      },
    },
  },
  delivery: { select: { id: true, recipient_name: true, status: true } },
  route: { select: { id: true, code: true, name: true } },
  occurrence: {
    select: {
      id: true,
      authorization_status: true,
      created_at: true,
      occurrenceType: { select: { name: true } },
    },
  },
  assignee: { select: { id: true, name: true } },
  openedBy: { select: { id: true, name: true } },
  closedBy: { select: { id: true, name: true } },
} satisfies Prisma.SupportTicketInclude;

type RowPayload = Prisma.SupportTicketGetPayload<{
  include: typeof rowInclude;
}>;

function toRow(payload: RowPayload): SupportTicketRow {
  const {
    thread,
    delivery,
    route,
    occurrence,
    assignee,
    openedBy,
    closedBy,
    ...ticket
  } = payload;

  return {
    ...(ticket as SupportTicket),
    driver: { id: thread.driver.id, name: thread.driver.name },
    driverUserId: thread.driver.User?.id ?? null,
    delivery: delivery
      ? {
          id: delivery.id,
          recipient_name: delivery.recipient_name,
          status: delivery.status,
        }
      : null,
    route: route ? { id: route.id, code: route.code, name: route.name } : null,
    occurrence: occurrence
      ? {
          id: occurrence.id,
          typeName: occurrence.occurrenceType.name,
          authorization_status: occurrence.authorization_status,
          created_at: occurrence.created_at,
        }
      : null,
    assignee,
    openedBy,
    closedBy,
  };
}

/**
 * "Unread" for the requester, the chat's rule applied to one ticket: the
 * driver's messages for the staff, everybody else's for the driver. The
 * effective cursor is the greater of the ticket's and the thread's — an app
 * build without tickets advances only the thread one, and reading the whole
 * conversation reads every subject in it (design §2.4).
 */
function unreadPredicate(requesterUserId: string): Prisma.Sql {
  return Prisma.sql`(
    CASE WHEN du."id" = ${requesterUserId}
      THEN m."senderId" <> ${requesterUserId}
      ELSE du."id" IS NOT NULL AND m."senderId" = du."id"
    END
  ) AND (
    GREATEST(r."last_read_at", tr."last_read_at") IS NULL
    OR m."created_at" > GREATEST(r."last_read_at", tr."last_read_at")
  )`;
}

function readJoins(requesterUserId: string): Prisma.Sql {
  return Prisma.sql`
    LEFT JOIN "user" du ON du."driverId" = t."driverId"
    LEFT JOIN "support_ticket_read" r
      ON r."ticketId" = t."id" AND r."userId" = ${requesterUserId}
    LEFT JOIN "chat_thread_read" tr
      ON tr."threadId" = t."threadId" AND tr."userId" = ${requesterUserId}
  `;
}

class SupportTicketRepository implements ISupportTicketRepository {
  constructor(private prisma = database) {}

  private client(tx?: unknown): Client {
    return (tx as Prisma.TransactionClient | undefined) ?? this.prisma;
  }

  async create(
    props: CreateSupportTicketProps,
    tx?: unknown,
  ): Promise<SupportTicket> {
    const run = async (client: Prisma.TransactionClient) => {
      // One statement allocates the number: concurrent creates of the same
      // company serialize on the counter row only for the commit, and a
      // create inside the report's transaction never needs a retry.
      const [{ last_number }] = await client.$queryRaw<
        Array<{ last_number: number }>
      >`
        INSERT INTO "support_ticket_counter" ("businessId", last_number)
        VALUES (${props.businessId}, 1)
        ON CONFLICT ("businessId")
        DO UPDATE SET last_number = "support_ticket_counter".last_number + 1
        RETURNING last_number
      `;

      return client.supportTicket.create({
        data: {
          number: last_number,
          kind: props.kind,
          subject: props.subject,
          businessId: props.businessId,
          threadId: props.threadId,
          driverId: props.driverId,
          deliveryId: props.deliveryId ?? null,
          occurrenceId: props.occurrenceId ?? null,
          routeId: props.routeId ?? null,
          opened_via: props.opened_via,
          openedById: props.openedById ?? null,
          client_submission_id: props.client_submission_id ?? null,
        },
      });
    };

    // Without a caller transaction the counter and the row still commit
    // together: a P2002 on the row rolls the number back, leaving no hole.
    return (
      tx ? run(tx as Prisma.TransactionClient) : this.prisma.$transaction(run)
    ) as Promise<SupportTicket>;
  }

  async findById(
    id: string,
    businessId: string,
    tx?: unknown,
  ): Promise<SupportTicket | null> {
    return (await this.client(tx).supportTicket.findFirst({
      where: { id, businessId },
    })) as SupportTicket | null;
  }

  async findRowById(
    id: string,
    businessId: string,
  ): Promise<SupportTicketRow | null> {
    const row = await this.prisma.supportTicket.findFirst({
      where: { id, businessId },
      include: rowInclude,
    });

    return row ? toRow(row) : null;
  }

  async findByOccurrence(
    occurrenceId: string,
    businessId: string,
    tx?: unknown,
  ): Promise<SupportTicket | null> {
    return (await this.client(tx).supportTicket.findFirst({
      where: { occurrenceId, businessId },
    })) as SupportTicket | null;
  }

  async findBySubmissionId(
    clientSubmissionId: string,
    businessId: string,
  ): Promise<SupportTicket | null> {
    return (await this.prisma.supportTicket.findFirst({
      where: { client_submission_id: clientSubmissionId, businessId },
    })) as SupportTicket | null;
  }

  async findOpenForDelivery(
    deliveryId: string,
    businessId: string,
    kind: "OCCURRENCE" | "DELIVERY",
    tx?: unknown,
  ): Promise<SupportTicket | null> {
    return (await this.client(tx).supportTicket.findFirst({
      where: { deliveryId, businessId, kind, status: "OPEN" },
      orderBy: [{ created_at: "desc" }, { id: "desc" }],
    })) as SupportTicket | null;
  }

  async findOpenForRoute(
    routeId: string,
    businessId: string,
  ): Promise<SupportTicket | null> {
    return (await this.prisma.supportTicket.findFirst({
      where: { routeId, businessId, kind: "ROUTE", status: "OPEN" },
    })) as SupportTicket | null;
  }

  async findLatestOpenDriverTicket(
    businessId: string,
    driverId: string,
  ): Promise<SupportTicket | null> {
    return (await this.prisma.supportTicket.findFirst({
      where: { businessId, driverId, kind: "DRIVER", status: "OPEN" },
      orderBy: [
        { last_message_at: { sort: "desc", nulls: "last" } },
        { created_at: "desc" },
        { id: "desc" },
      ],
    })) as SupportTicket | null;
  }

  async findLastStaffMessageTicket(
    threadId: string,
    driverUserId: string | null,
    before?: Date,
  ): Promise<{ ticket: SupportTicket; at: Date } | null> {
    const message = await this.prisma.chatMessage.findFirst({
      where: {
        threadId,
        ticketId: { not: null },
        broadcast_id: null,
        ...(driverUserId && { senderId: { not: driverUserId } }),
        ...(before && { created_at: { lt: before } }),
      },
      orderBy: [{ created_at: "desc" }, { id: "desc" }],
      select: { created_at: true, ticket: true },
    });

    if (!message?.ticket) return null;

    return { ticket: message.ticket as SupportTicket, at: message.created_at };
  }

  async lockForUpdate(
    id: string,
    businessId: string,
    tx: unknown,
  ): Promise<SupportTicket | null> {
    const client = tx as Prisma.TransactionClient;

    // The row lock serializes a message against a close: neither can land
    // "after" the other without seeing it.
    const locked = await client.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "support_ticket"
      WHERE "id" = ${id} AND "businessId" = ${businessId}
      FOR UPDATE
    `;

    if (locked.length === 0) return null;

    return (await client.supportTicket.findUnique({
      where: { id },
    })) as SupportTicket;
  }

  async linkOccurrence(
    id: string,
    occurrenceId: string,
    tx?: unknown,
  ): Promise<SupportTicket> {
    return (await this.client(tx).supportTicket.update({
      where: { id },
      data: { kind: "OCCURRENCE", occurrenceId, version: { increment: 1 } },
    })) as SupportTicket;
  }

  async close(props: CloseSupportTicketProps, tx?: unknown): Promise<boolean> {
    const result = await this.client(tx).supportTicket.updateMany({
      where: { id: props.id, businessId: props.businessId, status: "OPEN" },
      data: {
        status: "CLOSED",
        closedById: props.closedById,
        closed_at: props.at,
        close_outcome: props.outcome,
        close_note: props.note,
        version: { increment: 1 },
      },
    });

    return result.count > 0;
  }

  async assign(
    props: AssignSupportTicketProps,
    tx?: unknown,
  ): Promise<boolean> {
    const result = await this.client(tx).supportTicket.updateMany({
      where: {
        id: props.id,
        businessId: props.businessId,
        status: "OPEN",
        ...(props.expectedAssigneeId !== undefined && {
          assigneeId: props.expectedAssigneeId,
        }),
      },
      data: {
        assigneeId: props.assigneeId,
        assigned_at: props.assigneeId ? props.at : null,
        version: { increment: 1 },
      },
    });

    return result.count > 0;
  }

  async autoAssign(
    id: string,
    assigneeId: string,
    at: Date,
    tx?: unknown,
  ): Promise<boolean> {
    const result = await this.client(tx).supportTicket.updateMany({
      where: { id, assigneeId: null, status: "OPEN" },
      data: { assigneeId, assigned_at: at, version: { increment: 1 } },
    });

    return result.count > 0;
  }

  async reopen(id: string, businessId: string, tx?: unknown): Promise<boolean> {
    const result = await this.client(tx).supportTicket.updateMany({
      where: { id, businessId, status: "CLOSED" },
      data: {
        status: "OPEN",
        reopened_count: { increment: 1 },
        closedById: null,
        closed_at: null,
        close_outcome: null,
        close_note: null,
        version: { increment: 1 },
      },
    });

    return result.count > 0;
  }

  async touchOnMessage(
    props: { id: string; at: Date; side: "DRIVER" | "STAFF" },
    tx?: unknown,
  ): Promise<SupportTicket> {
    const client = this.client(tx);
    const sideColumn =
      props.side === "DRIVER"
        ? "last_driver_message_at"
        : "last_staff_message_at";

    // Each column is a conditional write: advance-only, so a repaired older
    // message never moves the ticket back in the list order. Each statement
    // is atomic on its own; the send path also holds the row lock.
    const advance = (column: "last_message_at" | typeof sideColumn) =>
      client.supportTicket.updateMany({
        where: {
          id: props.id,
          OR: [{ [column]: null }, { [column]: { lt: props.at } }],
        },
        data: { [column]: props.at },
      });

    await advance("last_message_at");
    await advance(sideColumn);

    if (props.side === "STAFF") {
      // The response-time metric keeps the EARLIEST reply.
      await client.supportTicket.updateMany({
        where: {
          id: props.id,
          OR: [
            { first_staff_reply_at: null },
            { first_staff_reply_at: { gt: props.at } },
          ],
        },
        data: { first_staff_reply_at: props.at },
      });
    }

    return (await client.supportTicket.update({
      where: { id: props.id },
      data: { version: { increment: 1 } },
    })) as SupportTicket;
  }

  async bumpVersion(id: string, tx?: unknown): Promise<SupportTicket> {
    return (await this.client(tx).supportTicket.update({
      where: { id },
      data: { version: { increment: 1 } },
    })) as SupportTicket;
  }

  async addEvent(
    props: CreateSupportTicketEventProps,
    tx?: unknown,
  ): Promise<SupportTicketEvent> {
    return (await this.client(tx).supportTicketEvent.create({
      data: {
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
      },
    })) as SupportTicketEvent;
  }

  async listEvents(
    ticketId: string,
    businessId: string,
    limit: number,
  ): Promise<SupportTicketEvent[]> {
    return (await this.prisma.supportTicketEvent.findMany({
      where: { ticketId, businessId },
      orderBy: [{ created_at: "asc" }, { id: "asc" }],
      take: limit,
    })) as SupportTicketEvent[];
  }

  /**
   * The search's joined arms resolved to ids first, each through an index
   * (docs/desempenho/banco-2026-10.md §9, limit 3): the recipient through
   * the deliveries' trigram index (rechecked on the column), the driver's
   * name over the company's drivers. The inbox then ORs `deliveryId IN` and
   * `driverId IN` (the ticket's own copy of its thread's driver) with the
   * number and the subject, columns of the ticket itself, instead of joining
   * two tables for every ticket the company ever had. Null keeps the joined
   * search: a short term, or a recipient too common for a list of ids.
   */
  private async resolveSearchMatches(
    props: ListSupportTicketsProps,
  ): Promise<TicketSearchMatches | null> {
    const term = props.search?.trim() ?? "";

    if (
      [...term].length < SEARCH_PREFILTER_MIN_LENGTH ||
      term.includes(SEARCH_FIELD_SEPARATOR)
    ) {
      return null;
    }

    const pattern = `%${escapeLikePattern(term)}%`;

    const deliveries = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "delivery"
      WHERE "businessId" = ${props.businessId}
        AND ${DELIVERY_SEARCH_TEXT} ILIKE ${pattern}
        AND "recipient_name" ILIKE ${pattern}
      LIMIT ${SEARCH_PREFILTER_CAP + 1}
    `;

    if (deliveries.length > SEARCH_PREFILTER_CAP) return null;

    const drivers = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "driver"
      WHERE "businessId" = ${props.businessId}
        AND "name" ILIKE ${pattern}
    `;

    return {
      deliveryIds: deliveries.map((row) => row.id),
      driverIds: drivers.map((row) => row.id),
    };
  }

  private listWhere(
    props: ListSupportTicketsProps,
    matches: TicketSearchMatches | null = null,
  ): Prisma.SupportTicketWhereInput {
    const search = props.search?.trim() ?? "";
    const numberMatch = /^#?(\d{1,9})$/.exec(search);

    const and: Prisma.SupportTicketWhereInput[] = [
      { businessId: props.businessId },
    ];

    if (props.driverId) and.push({ driverId: props.driverId });
    if (props.status !== "ALL") and.push({ status: props.status });
    if (props.kind) and.push({ kind: props.kind });
    if (props.filterDriverId) and.push({ driverId: props.filterDriverId });
    if (props.deliveryId) and.push({ deliveryId: props.deliveryId });
    if (props.routeId) and.push({ routeId: props.routeId });
    if (props.occurrenceId) and.push({ occurrenceId: props.occurrenceId });

    // The driver has no queue to filter: these narrow the tower's view only.
    if (!props.driverId) {
      if (props.scope === "MINE")
        and.push({ assigneeId: props.requesterUserId });
      if (props.scope === "UNASSIGNED")
        and.push({ assigneeId: null, status: "OPEN" });
      if (props.scope === "PENDING_AUTHORIZATION") {
        and.push({ occurrence: { is: { authorization_status: "PENDING" } } });
      }
    }

    if (search) {
      const contains = {
        contains: escapeLikePattern(search),
        mode: "insensitive" as const,
      };

      // An empty `in` would match nothing, so an empty list drops its arm.
      const joinedArms: Prisma.SupportTicketWhereInput[] = matches
        ? [
            ...(matches.driverIds.length > 0
              ? [{ driverId: { in: matches.driverIds } }]
              : []),
            ...(matches.deliveryIds.length > 0
              ? [{ deliveryId: { in: matches.deliveryIds } }]
              : []),
          ]
        : [
            { thread: { driver: { name: contains } } },
            { delivery: { is: { recipient_name: contains } } },
          ];

      and.push({
        OR: [
          ...(numberMatch ? [{ number: Number(numberMatch[1]) }] : []),
          { subject: contains },
          ...joinedArms,
        ],
      });
    }

    return { AND: and };
  }

  async list(
    props: ListSupportTicketsProps,
  ): Promise<{ data: SupportTicketRow[]; total: number }> {
    const where = this.listWhere(props, await this.resolveSearchMatches(props));

    const orderBy: Prisma.SupportTicketOrderByWithRelationInput[] =
      props.status === "CLOSED"
        ? [{ closed_at: { sort: "desc", nulls: "last" } }, { id: "desc" }]
        : [
            { last_message_at: { sort: "desc", nulls: "last" } },
            { created_at: "desc" },
            { id: "desc" },
          ];

    const [rows, total] = await Promise.all([
      this.prisma.supportTicket.findMany({
        where,
        orderBy,
        skip: (props.page - 1) * props.pageSize,
        take: props.pageSize,
        include: rowInclude,
      }),
      this.prisma.supportTicket.count({ where }),
    ]);

    return { data: rows.map(toRow), total };
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
    const open: Prisma.SupportTicketWhereInput = {
      businessId,
      status: "OPEN",
      ...(driverId && { driverId }),
    };

    const driverScope = driverId
      ? Prisma.sql`AND t."driverId" = ${driverId}`
      : Prisma.empty;

    // Two at a time: at most two of the replica's ten connections (the
    // budget of tests/E2E/connection-fan-out.test.ts); it took five at once.
    // Each count is an index read of the company's OPEN tickets.
    const [openCount, unassigned] = await Promise.all([
      this.prisma.supportTicket.count({ where: open }),
      this.prisma.supportTicket.count({ where: { ...open, assigneeId: null } }),
    ]);

    const [mine, pendingAuthorization] = await Promise.all([
      this.prisma.supportTicket.count({
        where: { ...open, assigneeId: requesterUserId },
      }),
      this.prisma.supportTicket.count({
        where: {
          ...open,
          occurrence: { is: { authorization_status: "PENDING" } },
        },
      }),
    ]);

    const unreadRows = await this.prisma.$queryRaw<
      Array<{ total: number }>
    >(Prisma.sql`
      SELECT COUNT(*)::int AS "total" FROM (
        SELECT 1
        FROM "support_ticket" t
        ${readJoins(requesterUserId)}
        JOIN LATERAL (
          SELECT 1 FROM "chat_message" m
          WHERE m."ticketId" = t."id" AND ${unreadPredicate(requesterUserId)}
          LIMIT 1
        ) hit ON true
        WHERE t."businessId" = ${businessId} AND t."status" = 'OPEN'
        ${driverScope}
        LIMIT ${UNREAD_DISPLAY_CAP}
      ) capped
    `);

    return {
      open: openCount,
      unassigned,
      mine,
      pendingAuthorization,
      unreadOpen: unreadRows[0]?.total ?? 0,
    };
  }

  async unreadCounts(
    ticketIds: string[],
    requesterUserId: string,
    _viewerIsDriverSide: boolean,
  ): Promise<Map<string, number>> {
    if (ticketIds.length === 0) return new Map();

    const rows = await this.prisma.$queryRaw<
      Array<{ ticketId: string; unread: number }>
    >(
      Prisma.sql`
        SELECT t."id" AS "ticketId", capped."unread"
        FROM "support_ticket" t
        ${readJoins(requesterUserId)}
        CROSS JOIN LATERAL (
          SELECT COUNT(*)::int AS "unread" FROM (
            SELECT 1 FROM "chat_message" m
            WHERE m."ticketId" = t."id" AND ${unreadPredicate(requesterUserId)}
            LIMIT ${UNREAD_DISPLAY_CAP}
          ) rows_
        ) capped
        WHERE t."id" IN (${Prisma.join(ticketIds)})
      `,
    );

    return new Map(rows.map((row) => [row.ticketId, row.unread]));
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

    if (ticketIds.length === 0) return result;

    // A LATERAL per ticket: one backward probe of (ticketId, created_at).
    const rows = await this.prisma.$queryRaw<
      Array<{
        ticketId: string;
        kind: "TEXT" | "IMAGE" | "AUDIO";
        body: string | null;
        senderId: string;
        senderName: string | null;
        created_at: Date;
      }>
    >(Prisma.sql`
      SELECT t."id" AS "ticketId", last_."kind", last_."body", last_."senderId",
             u."name" AS "senderName", last_."created_at"
      FROM "support_ticket" t
      CROSS JOIN LATERAL (
        SELECT m."kind", m."body", m."senderId", m."created_at"
        FROM "chat_message" m
        WHERE m."ticketId" = t."id"
        ORDER BY m."created_at" DESC, m."id" DESC
        LIMIT 1
      ) last_
      LEFT JOIN "user" u ON u."id" = last_."senderId"
      WHERE t."id" IN (${Prisma.join(ticketIds)})
    `);

    for (const row of rows) {
      result.set(row.ticketId, {
        kind: row.kind,
        body: row.body,
        sender: { id: row.senderId, name: row.senderName ?? "" },
        created_at: row.created_at,
      });
    }

    return result;
  }

  async counterpartReadCursors(
    ticketIds: string[],
    driverUserId: string | null,
    viewerIsDriverSide: boolean,
  ): Promise<Map<string, Date>> {
    // A driver with no account never read anything.
    if (ticketIds.length === 0 || (!viewerIsDriverSide && !driverUserId))
      return new Map();

    const rows = await this.prisma.supportTicketRead.groupBy({
      by: ["ticketId"],
      where: {
        ticketId: { in: ticketIds },
        ...(viewerIsDriverSide
          ? driverUserId && { userId: { not: driverUserId } }
          : { userId: driverUserId! }),
      },
      _max: { last_read_at: true },
    });

    const result = new Map<string, Date>();

    for (const row of rows) {
      if (row._max.last_read_at)
        result.set(row.ticketId, row._max.last_read_at);
    }

    return result;
  }

  async markRead(ticketId: string, userId: string, at: Date): Promise<void> {
    // Advance-only, like the thread cursor: a stale call never rewinds.
    const updated = await this.prisma.supportTicketRead.updateMany({
      where: { ticketId, userId, last_read_at: { lt: at } },
      data: { last_read_at: at },
    });

    if (updated.count === 0) {
      await this.prisma.supportTicketRead.createMany({
        data: [{ ticketId, userId, last_read_at: at }],
        skipDuplicates: true,
      });
    }
  }

  async findManyRows(
    ids: string[],
    businessId: string,
  ): Promise<SupportTicketRow[]> {
    if (ids.length === 0) return [];

    const rows = await this.prisma.supportTicket.findMany({
      where: { id: { in: ids }, businessId },
      include: rowInclude,
    });

    return rows.map(toRow);
  }

  async listUnticketedMessages(limit: number, since: Date) {
    const rows = await this.prisma.chatMessage.findMany({
      // The created_at bound turns the walk into a range of the
      // (ticketId, created_at) index instead of every mass notice ever sent.
      where: { ticketId: null, broadcast_id: null, created_at: { gte: since } },
      orderBy: [{ created_at: "asc" }, { id: "asc" }],
      take: limit,
      select: {
        id: true,
        threadId: true,
        senderId: true,
        deliveryId: true,
        routeId: true,
        created_at: true,
        thread: { select: { businessId: true, driverId: true } },
      },
    });

    return rows.map((row) => ({
      id: row.id,
      threadId: row.threadId,
      businessId: row.thread.businessId,
      driverId: row.thread.driverId,
      senderId: row.senderId,
      deliveryId: row.deliveryId,
      routeId: row.routeId,
      created_at: row.created_at,
    }));
  }

  async ticketsBackfilledAt(): Promise<Date | null> {
    const rows = await this.prisma.$queryRaw<
      Array<{ finished_at: Date | null }>
    >`
      SELECT finished_at FROM _prisma_migrations
      WHERE migration_name = ${TICKETS_BACKFILL_MIGRATION}
        AND rolled_back_at IS NULL
        AND finished_at IS NOT NULL
      ORDER BY finished_at DESC
      LIMIT 1
    `;

    return rows[0]?.finished_at ?? null;
  }

  async attachMessage(
    messageId: string,
    ticketId: string,
    tx?: unknown,
  ): Promise<boolean> {
    const result = await this.client(tx).chatMessage.updateMany({
      where: { id: messageId, ticketId: null },
      data: { ticketId },
    });

    return result.count > 0;
  }
}

export {
  SupportTicketRepository,
  UNREAD_DISPLAY_CAP as SUPPORT_TICKET_UNREAD_CAP,
};
