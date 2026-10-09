import { Prisma } from "@prisma/client";

import { ChatRouteRef, IChatRepository } from "./IChat-repository";
import {
  ChatAudienceCount,
  ChatBroadcastTarget,
  ChatDeliverySide,
  ChatMessage,
  ChatMessageSearchHit,
  ChatMessageView,
  ChatThread,
  CreateChatMessageProps,
  ListChatMessagesProps,
  ListChatMessagesResult,
  ListChatThreadsProps,
  ListChatRecipientsProps,
  ListChatRecipientsResult,
  ListChatThreadsResult,
  SearchChatMessagesProps,
} from "../dtos/chat-dto";

import database from "@/../infra/database";
import { escapeLikePattern } from "@/shared/utils/like-pattern";
import { buildSearchOr } from "@/shared/pagination/search-or";

const messageInclude = {
  sender: { select: { id: true, name: true } },
  delivery: { select: { id: true, recipient_name: true, status: true } },
  route: { select: { id: true, code: true, name: true } },
} satisfies Prisma.ChatMessageInclude;

/**
 * "Can read the thread": a driver whose app account could log in, as
 * `assertSessionEligible` decides it — not revoked, of this company, and
 * not held in an inactive branch. `access_revoked` alone counted a driver of
 * an inactive branch as reached: he was in "everyone", got rung and was
 * reported SENT without being able to open the app. The driver's own status
 * is the caller's ACTIVE filter. The use case asks the same question of a
 * hand-picked driver through the login rule itself (`canUseApp`).
 */
function hasApp(businessId: string): Prisma.DriverWhereInput {
  return {
    User: { is: { access_revoked: false, businessId } },
    OR: [{ branchId: null }, { branch: { is: { is_active: true } } }],
  };
}

function withoutApp(businessId: string): Prisma.DriverWhereInput {
  return { NOT: hasApp(businessId) };
}

/** Route statuses a driver still works on: a stop there is "his" delivery. */
const OPEN_ROUTE_STATUSES = new Set(["RELEASED", "IN_PROGRESS"]);

const ROUTE_REF_SELECT = {
  id: true,
  businessId: true,
  driverId: true,
  code: true,
  name: true,
} satisfies Prisma.RouteSelect;

/**
 * Where counting unread stops being worth anything.
 *
 * The badge draws "99+" past ninety-nine, on the tab, the sidebar and every
 * conversation row. A hundred is therefore the last number the interface can
 * tell apart, and everything counted past it is thrown away on the way to the
 * screen.
 */
const UNREAD_DISPLAY_CAP = 100;

class ChatRepository implements IChatRepository {
  constructor(private prisma = database) {}

  async findThreadById(threadId: string): Promise<ChatThread | null> {
    return this.prisma.chatThread.findUnique({ where: { id: threadId } });
  }

  async findThreadByDriver(
    businessId: string,
    driverId: string,
  ): Promise<ChatThread | null> {
    return this.prisma.chatThread.findUnique({
      where: { businessId_driverId: { businessId, driverId } },
    });
  }

  async getOrCreateThread(
    businessId: string,
    driverId: string,
    tx?: unknown,
  ): Promise<ChatThread> {
    const client = (tx as Prisma.TransactionClient | undefined) ?? this.prisma;
    const where = { businessId_driverId: { businessId, driverId } };

    // Every message after the first finds its thread here, in one statement.
    const existing = await client.chatThread.findUnique({ where });
    if (existing) return existing;

    // Two first messages racing (two agents, or agent and driver) converge on
    // the same thread: ON CONFLICT DO NOTHING, then read whichever row won.
    // Not `upsert({ update: {} })`: with an empty update Prisma runs a SELECT
    // and an INSERT, and the loser of the race got P2002 — its message failed
    // (tests/E2E/get-or-create-races.test.ts).
    await client.chatThread.createMany({
      data: [{ businessId, driverId }],
      skipDuplicates: true,
    });

    return client.chatThread.findUniqueOrThrow({ where });
  }

  async listThreads({
    businessId,
    requesterUserId,
    driverId,
    search,
    page,
    pageSize,
  }: ListChatThreadsProps): Promise<ListChatThreadsResult> {
    const skip = (page - 1) * pageSize;
    const normalizedSearch = search ? search.trim() : "";

    const whereCondition: Prisma.ChatThreadWhereInput = {
      businessId,
      ...(driverId && { driverId }),
      ...(normalizedSearch && {
        driver: {
          name: {
            contains: escapeLikePattern(normalizedSearch),
            mode: "insensitive" as const,
          },
        },
      }),
    };

    // The page beside its count, the unread total after them: at most two of
    // the replica's ten connections (tests/E2E/connection-fan-out.test.ts).
    const [threads, total] = await Promise.all([
      this.prisma.chatThread.findMany({
        skip,
        take: pageSize,
        where: whereCondition,
        // Fresh conversations first; threads never written to sink to the
        // bottom by creation date.
        orderBy: [
          { last_message_at: { sort: "desc", nulls: "last" } },
          { created_at: "desc" },
          // Closes the order: two threads created in the same instant came
          // back in any order, and an offset page could repeat or skip one.
          { id: "desc" },
        ],
        include: {
          driver: {
            select: {
              id: true,
              name: true,
              cnh: true,
              User: { select: { id: true, last_seen_at: true } },
            },
          },
        },
      }),
      this.prisma.chatThread.count({ where: whereCondition }),
    ]);

    const totalUnread = await this.countTotalUnread({ businessId, requesterUserId, driverId });

    const pageIds = threads.map((thread) => thread.id);

    // Both of these need the page before they can run, and neither needs the
    // other — one round trip for the two.
    const [unreadRows, previews] = await Promise.all([
      // Counted for the PAGE, not for every thread the company ever opened:
      // the list only draws a badge for the rows it is showing.
      this.countUnreadForThreads(pageIds, requesterUserId),
      this.lastMessageForThreads(pageIds),
    ]);

    // The thread id keys the map and stays out of the preview: it leaked
    // into every row of the list as an undocumented `lastMessage.threadId`.
    const previewByThread = new Map(
      previews.map(({ threadId, ...preview }) => [threadId, preview]),
    );

    const unreadByThread = new Map(
      unreadRows.map((row) => [row.threadId, row.unread]),
    );

    const data = threads.map((thread) => ({
      id: thread.id,
      driver: {
        id: thread.driver.id,
        name: thread.driver.name,
        cnh: thread.driver.cnh,
      },
      driverUser: thread.driver.User
        ? {
            id: thread.driver.User.id,
            last_seen_at: thread.driver.User.last_seen_at,
          }
        : null,
      lastMessage: previewByThread.get(thread.id) ?? null,
      unreadCount: unreadByThread.get(thread.id) ?? 0,
    }));

    return { data, total, totalUnread };
  }

  /**
   * The newest message of each thread on the page — the preview line.
   *
   * Written by hand because Prisma's nested `take: 1` is a trap at this size.
   * It compiles the include into `ROW_NUMBER() OVER (PARTITION BY "threadId")`
   * over every message of every thread on the page, and the planner served
   * that with a Seq Scan of the whole table: 1.3M rows read and 20,000 sorted
   * to pick twenty. Measured at 308 ms, and it was the single most expensive
   * thing in the conversation list — more than the unread count it hid behind.
   *
   * A LATERAL asks the question the index can already answer: for this thread,
   * the last row. Twenty backward index probes. Measured at 0.9 ms.
   */
  private async lastMessageForThreads(threadIds: string[]): Promise<
    Array<{
      threadId: string;
      kind: ChatMessage["kind"];
      body: string | null;
      sender: { id: string; name: string };
      created_at: Date;
    }>
  > {
    if (threadIds.length === 0) return [];

    const rows = await this.prisma.$queryRaw<
      Array<{
        threadId: string;
        kind: ChatMessage["kind"];
        body: string | null;
        senderId: string;
        senderName: string | null;
        created_at: Date;
      }>
    >(Prisma.sql`
      SELECT
        t."id" AS "threadId",
        last_."kind",
        last_."body",
        last_."senderId",
        u."name" AS "senderName",
        last_."created_at"
      FROM "chat_thread" t
      CROSS JOIN LATERAL (
        SELECT m."kind", m."body", m."senderId", m."created_at"
        FROM "chat_message" m
        WHERE m."threadId" = t."id"
        ORDER BY m."created_at" DESC, m."id" DESC
        LIMIT 1
      ) last_
      LEFT JOIN "user" u ON u."id" = last_."senderId"
      WHERE t."id" IN (${Prisma.join(threadIds)})
    `);

    return rows.map((row) => ({
      threadId: row.threadId,
      kind: row.kind,
      body: row.body,
      sender: { id: row.senderId, name: row.senderName ?? "" },
      created_at: row.created_at,
    }));
  }

  /**
   * Unread per thread, for the threads on screen and no further.
   *
   * Two ceilings, and both were measured before they were chosen. On 1.3M
   * messages (1,000 drivers, a year of conversation) the old statement was a
   * Parallel Seq Scan of the whole table — 458 ms per load of the list, per
   * agent, and now also while nobody is looking at the chat, because the panel
   * keeps an app-wide listener. It had no bound by construction: a thread the
   * agent never opened has no cursor, so "unread" is its entire history.
   *
   *   1. Only the page. The list draws a badge for twenty rows; counting the
   *      other nine hundred and eighty was work nobody could see.
   *   2. `LIMIT UNREAD_DISPLAY_CAP` inside the lateral. The badge renders
   *      "99+" past ninety-nine, so counting the forty-thousandth unread
   *      message was buying a number the interface throws away.
   *
   * Measured after: 5.2 ms, Index Only Scan, no heap access — the index is
   * ("threadId", "created_at", "senderId") and the count never leaves it.
   *
   * Still DERIVED, which is the part that was already right: an accumulated
   * counter would need atomic increments and reconciliation across replicas,
   * and a count over an index cannot drift.
   */
  private async countUnreadForThreads(
    threadIds: string[],
    requesterUserId: string,
  ): Promise<Array<{ threadId: string; unread: number }>> {
    if (threadIds.length === 0) return [];

    return this.prisma.$queryRaw<Array<{ threadId: string; unread: number }>>(
      Prisma.sql`
        SELECT t."id" AS "threadId", capped."unread"
        FROM "chat_thread" t
        LEFT JOIN "user" du ON du."driverId" = t."driverId"
        LEFT JOIN "chat_thread_read" r
          ON r."threadId" = t."id" AND r."userId" = ${requesterUserId}
        CROSS JOIN LATERAL (
          SELECT COUNT(*)::int AS "unread" FROM (
            SELECT 1 FROM "chat_message" m
            WHERE m."threadId" = t."id"
              AND ${ChatRepository.unreadSideFilter(requesterUserId)}
              AND (r."last_read_at" IS NULL OR m."created_at" > r."last_read_at")
            LIMIT ${UNREAD_DISPLAY_CAP}
          ) rows_
        ) capped
        WHERE t."id" IN (${Prisma.join(threadIds)})
      `,
    );
  }

  /**
   * Whose messages count as unread to the reader.
   *
   * The driver side of a thread is its driver's user: for a staff requester
   * those are the unread ones, for the driver everybody else's. `du` is
   * LEFT JOINed, so a driver with no app account simply has nothing unread —
   * which is true, and is why the null check has to be here rather than in
   * the WHERE, where it would drop the thread from the answer entirely.
   */
  private static unreadSideFilter(requesterUserId: string): Prisma.Sql {
    return Prisma.sql`(
      CASE WHEN du."id" = ${requesterUserId}
        THEN m."senderId" <> ${requesterUserId}
        ELSE du."id" IS NOT NULL AND m."senderId" = du."id"
      END
    )`;
  }

  /**
   * The company-wide unread total behind the tab badge.
   *
   * Stops at the cap instead of adding everything up: the badge says "99+"
   * past ninety-nine, so the hundredth unread message is the last one worth
   * finding. The LIMIT is what lets the executor give up early.
   *
   * The case that decides the shape is the boring one — a team that is up to
   * date. There is nothing to find, so no early exit can help, and the query
   * has to prove the absence: one index probe per thread that lands on
   * nothing. Measured at 14 ms over a thousand threads, against 458 ms for
   * the statement this replaces, which paid the full scan every time.
   */
  private async countTotalUnread({
    businessId,
    requesterUserId,
    driverId,
  }: {
    businessId: string;
    requesterUserId: string;
    driverId?: string;
  }): Promise<number> {
    const driverScope = driverId
      ? Prisma.sql`AND t."driverId" = ${driverId}`
      : Prisma.empty;

    const [row] = await this.prisma.$queryRaw<Array<{ total: number }>>(
      Prisma.sql`
        SELECT COUNT(*)::int AS "total" FROM (
          SELECT 1
          FROM "chat_thread" t
          LEFT JOIN "user" du ON du."driverId" = t."driverId"
          LEFT JOIN "chat_thread_read" r
            ON r."threadId" = t."id" AND r."userId" = ${requesterUserId}
          JOIN LATERAL (
            SELECT 1 FROM "chat_message" m
            WHERE m."threadId" = t."id"
              AND ${ChatRepository.unreadSideFilter(requesterUserId)}
              AND (r."last_read_at" IS NULL OR m."created_at" > r."last_read_at")
            LIMIT ${UNREAD_DISPLAY_CAP}
          ) hit ON true
          WHERE t."businessId" = ${businessId}
          ${driverScope}
          LIMIT ${UNREAD_DISPLAY_CAP}
        ) capped
      `,
    );

    return row?.total ?? 0;
  }

  /** Strictly older than the pair — the cursor's backward half. */
  private static olderThan(point: {
    created_at: Date;
    id: string;
  }): Prisma.ChatMessageWhereInput {
    return {
      OR: [
        { created_at: { lt: point.created_at } },
        { created_at: point.created_at, id: { lt: point.id } },
      ],
    };
  }

  /** Strictly newer than the pair — the mirror, used walking forward. */
  private static newerThan(point: {
    created_at: Date;
    id: string;
  }): Prisma.ChatMessageWhereInput {
    return {
      OR: [
        { created_at: { gt: point.created_at } },
        { created_at: point.created_at, id: { gt: point.id } },
      ],
    };
  }

  async listMessages({
    threadId,
    viewerIsDriverSide,
    before,
    after,
    around,
    limit,
    search,
    deliveryId,
    routeId,
    ticketId,
  }: ListChatMessagesProps): Promise<ListChatMessagesResult> {
    const normalizedSearch = search ? search.trim() : "";

    const base: Prisma.ChatMessageWhereInput = {
      threadId,
      // Filters narrow the one thread; the partial indexes on each column
      // serve a route's or a delivery's messages without the thread scan.
      ...(deliveryId && { deliveryId }),
      ...(routeId && { routeId }),
      // A ticket narrows the same thread; served by (ticketId, created_at).
      ...(ticketId && { ticketId }),
      ...(normalizedSearch && {
        body: {
          contains: escapeLikePattern(normalizedSearch),
          mode: "insensitive" as const,
        },
      }),
    };

    const counterpartCursors = await this.getCounterpartCursors(
      threadId,
      viewerIsDriverSide,
    );

    // ------------------------------------------------ centred on a message
    if (around) {
      // Half the page on each side of the anchor, the anchor itself riding
      // with the older half so a limit of 1 still answers something.
      const newerCount = Math.floor(limit / 2);
      const olderCount = Math.max(1, limit - newerCount);

      const [newer, olderIncludingAnchor] = await Promise.all([
        this.prisma.chatMessage.findMany({
          where: { ...base, ...ChatRepository.newerThan(around) },
          // Ascending here so the LIMIT keeps the rows nearest the anchor;
          // descending would take the newest of the thread instead.
          orderBy: [{ created_at: "asc" }, { id: "asc" }],
          take: newerCount + 1,
          include: messageInclude,
        }),
        this.prisma.chatMessage.findMany({
          where: {
            ...base,
            OR: [
              { created_at: around.created_at, id: around.id },
              ...(ChatRepository.olderThan(around).OR as Prisma.ChatMessageWhereInput[]),
            ],
          },
          orderBy: [{ created_at: "desc" }, { id: "desc" }],
          take: olderCount + 1,
          include: messageInclude,
        }),
      ]);

      const hasNewer = newer.length > newerCount;
      const hasOlder = olderIncludingAnchor.length > olderCount;

      const newerPage = hasNewer ? newer.slice(0, newerCount) : newer;
      const olderPage = hasOlder
        ? olderIncludingAnchor.slice(0, olderCount)
        : olderIncludingAnchor;

      // Back to the newest-first order every other page answers in.
      const data = [...newerPage].reverse().concat(olderPage);

      const newest = data[0];
      const oldest = data[data.length - 1];

      return {
        data: data as ChatMessageView[],
        nextCursor:
          hasOlder && oldest
            ? { created_at: oldest.created_at.toISOString(), id: oldest.id }
            : null,
        previousCursor:
          hasNewer && newest
            ? { created_at: newest.created_at.toISOString(), id: newest.id }
            : null,
        hasNewer,
        ...counterpartCursors,
      };
    }

    // ------------------------------------------------- walking forward
    if (after) {
      const rows = await this.prisma.chatMessage.findMany({
        where: { ...base, ...ChatRepository.newerThan(after) },
        orderBy: [{ created_at: "asc" }, { id: "asc" }],
        take: limit + 1,
        include: messageInclude,
      });

      const hasNewer = rows.length > limit;
      const page = hasNewer ? rows.slice(0, limit) : rows;

      const data = [...page].reverse();
      const newest = data[0];

      return {
        data: data as ChatMessageView[],
        // Walking forward says nothing about the past; the caller keeps the
        // backward cursor it already had.
        nextCursor: null,
        previousCursor:
          hasNewer && newest
            ? { created_at: newest.created_at.toISOString(), id: newest.id }
            : null,
        hasNewer,
        ...counterpartCursors,
      };
    }

    // ------------------------------------------- the end of the thread
    const rows = await this.prisma.chatMessage.findMany({
      where: { ...base, ...(before ? ChatRepository.olderThan(before) : {}) },
      // Newest first with the id as tiebreaker — the cursor pair.
      orderBy: [{ created_at: "desc" }, { id: "desc" }],
      take: limit + 1,
      include: messageInclude,
    });

    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;

    const oldest = data[data.length - 1];

    return {
      data: data as ChatMessageView[],
      nextCursor:
        hasMore && oldest
          ? { created_at: oldest.created_at.toISOString(), id: oldest.id }
          : null,
      // Paging backwards from the end: there is nothing newer by definition,
      // and paging further back never changes that.
      previousCursor: null,
      hasNewer: false,
      ...counterpartCursors,
    };
  }

  /**
   * The other side's two cursors in one thread lookup: how far it has read
   * and, for a staff viewer, how far the driver's device has received. The
   * delivery cursor rides the thread row that was already being fetched, so
   * the grey double check costs no extra round-trip.
   */
  private async getCounterpartCursors(
    threadId: string,
    viewerIsDriverSide: boolean,
  ): Promise<{
    counterpartLastReadAt: Date | null;
    counterpartDeliveredAt: Date | null;
  }> {
    const thread = await this.prisma.chatThread.findUnique({
      where: { id: threadId },
      select: {
        driver_delivered_at: true,
        staff_delivered_at: true,
        driver: { select: { User: { select: { id: true } } } },
      },
    });

    const driverUserId = thread?.driver.User?.id;

    if (viewerIsDriverSide) {
      // The company reads as a team: any agent's cursor counts.
      const staffRead = await this.prisma.chatThreadRead.findFirst({
        where: { threadId, ...(driverUserId && { userId: { not: driverUserId } }) },
        orderBy: { last_read_at: "desc" },
        select: { last_read_at: true },
      });

      // For the driver, "delivered" means an agent's panel actually has the
      // message — not that the server stored it. Storage is what the single
      // check already says; this is the second one.
      return {
        counterpartLastReadAt: staffRead?.last_read_at ?? null,
        counterpartDeliveredAt: thread?.staff_delivered_at ?? null,
      };
    }

    const counterpartDeliveredAt = thread?.driver_delivered_at ?? null;

    if (!driverUserId) {
      return { counterpartLastReadAt: null, counterpartDeliveredAt };
    }

    const driverRead = await this.prisma.chatThreadRead.findUnique({
      where: { threadId_userId: { threadId, userId: driverUserId } },
      select: { last_read_at: true },
    });

    return {
      counterpartLastReadAt: driverRead?.last_read_at ?? null,
      counterpartDeliveredAt,
    };
  }

  async searchMessages({
    businessId,
    search,
    limit,
    driverId,
  }: SearchChatMessagesProps): Promise<ChatMessageSearchHit[]> {
    const normalizedSearch = search.trim();

    if (!normalizedSearch) return [];

    const rows = await this.prisma.chatMessage.findMany({
      where: {
        thread: { businessId, ...(driverId && { driverId }) },
        // Literal text: "50%" is not "50 and anything after it". The
        // trigram index serves an escaped pattern the same way.
        body: {
          contains: escapeLikePattern(normalizedSearch),
          mode: "insensitive" as const,
        },
      },
      orderBy: [{ created_at: "desc" }, { id: "desc" }],
      take: limit,
      include: {
        ...messageInclude,
        thread: {
          select: { driver: { select: { id: true, name: true } } },
        },
      },
    });

    return rows.map(({ thread, ...message }) => ({
      ...(message as ChatMessageView),
      driver: thread.driver,
    }));
  }

  async createMessage(
    props: CreateChatMessageProps,
    tx?: unknown,
  ): Promise<ChatMessage> {
    // Message and ordering key commit together — last_message_at can never
    // drift from the messages it orders by. When the use case brings its
    // own transaction (to publish the outbox event alongside), both writes
    // join it instead of opening a nested one.
    const run = async (client: Prisma.TransactionClient) => {
      const message = await client.chatMessage.create({
        data: {
          threadId: props.threadId,
          senderId: props.senderId,
          kind: props.kind,
          body: props.body,
          attachment_key: props.attachment_key,
          duration_ms: props.duration_ms,
          deliveryId: props.deliveryId,
          routeId: props.routeId,
          broadcast_id: props.broadcast_id,
          client_submission_id: props.client_submission_id,
          ticketId: props.ticketId ?? null,
        },
      });

      await client.chatThread.update({
        where: { id: props.threadId },
        data: { last_message_at: message.created_at },
      });

      return message;
    };

    return tx
      ? run(tx as Prisma.TransactionClient)
      : this.prisma.$transaction(run);
  }

  async findMessageById(messageId: string): Promise<ChatMessage | null> {
    return this.prisma.chatMessage.findUnique({ where: { id: messageId } });
  }

  async findMessageBySubmissionId(
    clientSubmissionId: string,
    businessId: string,
  ): Promise<ChatMessage | null> {
    // `findFirst`, not `findUnique`: the key is globally unique, but the
    // question is "this message IN THIS company?" — another company's key
    // must read as absent.
    return this.prisma.chatMessage.findFirst({
      where: {
        client_submission_id: clientSubmissionId,
        thread: { businessId },
      },
    });
  }

  async markThreadRead(
    threadId: string,
    userId: string,
    at: Date,
  ): Promise<void> {
    // Advance-only: a stale mark-read arriving out of order (two tabs, a
    // retried request) can never rewind the cursor and "unread" messages.
    const updated = await this.prisma.chatThreadRead.updateMany({
      where: { threadId, userId, last_read_at: { lt: at } },
      data: { last_read_at: at },
    });

    if (updated.count === 0) {
      // No row yet — or one already ahead, which skipDuplicates makes a
      // no-op even when two replicas race the same first read.
      await this.prisma.chatThreadRead.createMany({
        data: [{ threadId, userId, last_read_at: at }],
        skipDuplicates: true,
      });
    }
  }

  async markThreadDelivered(
    threadId: string,
    at: Date,
    side: ChatDeliverySide,
  ): Promise<void> {
    // Advance-only in a single statement: a receipt retried by the phone, a
    // second agent's panel confirming the same message, or two receipts
    // crossing on the wire can never rewind the cursor and undeliver what a
    // device already holds. The guard lives in the WHERE so replicas racing
    // resolve at the database, not in memory — which is also what makes the
    // staff side safe with a whole team confirming at once.
    // Spelled out per side rather than by computed key: Prisma's where and
    // data types are literal, and a string index would silently widen them.
    const where: Prisma.ChatThreadWhereInput =
      side === "DRIVER"
        ? {
            id: threadId,
            OR: [
              { driver_delivered_at: null },
              { driver_delivered_at: { lt: at } },
            ],
          }
        : {
            id: threadId,
            OR: [
              { staff_delivered_at: null },
              { staff_delivered_at: { lt: at } },
            ],
          };

    await this.prisma.chatThread.updateMany({
      where,
      data:
        side === "DRIVER"
          ? { driver_delivered_at: at }
          : { staff_delivered_at: at },
    });
  }

  async listRecipients({
    businessId,
    search,
    app,
    cursor,
    limit,
  }: ListChatRecipientsProps): Promise<ListChatRecipientsResult> {
    const normalizedSearch = search?.trim() ?? "";

    const active: Prisma.DriverWhereInput = { businessId, status: "ACTIVE" };

    // Keyset, not Prisma's `cursor + skip: 1`: that drops the row after an
    // anchor that no longer passes the filter, so a driver made inactive
    // between two pages hid a colleague. The anchor is read without the
    // list's filter, inside the company. It is positioned by its CURRENT
    // name: an anchor renamed between pages still moves the window.
    let after: Prisma.DriverWhereInput | undefined;

    if (cursor) {
      const anchor = await this.prisma.driver.findFirst({
        where: { id: cursor, businessId },
        select: { id: true, name: true },
      });

      if (!anchor) return { data: [], nextCursor: null, hasMore: false };

      after = {
        OR: [
          { name: { gt: anchor.name } },
          { name: anchor.name, id: { gt: anchor.id } },
        ],
      };
    }

    const where: Prisma.DriverWhereInput = {
      AND: [
        active,
        ...(app === "WITH_APP" ? [hasApp(businessId)] : []),
        ...(app === "WITHOUT_APP" ? [withoutApp(businessId)] : []),
        // By name only. The CNH is registration data, and this list is read
        // under delivery_manage, not driver_manage: it neither answers nor
        // matches on it (decision 4.7 — only what the choice needs).
        ...(normalizedSearch
          ? [
              buildSearchOr<Prisma.DriverWhereInput>([
                { name: { contains: normalizedSearch, mode: "insensitive" } },
              ]),
            ]
          : []),
        ...(after ? [after] : []),
      ],
    };

    // The page, plus which of its rows can use the app, in the same rule
    // the audience counts with — not re-derived from the selected columns.
    const rows = await this.prisma.driver.findMany({
      where,
      select: { id: true, name: true },
      // Alphabetical: a person looks a colleague up by name. The id breaks
      // ties so the cursor walks a total order.
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const withAppIds =
      app === "WITH_APP"
        ? new Set(page.map((row) => row.id))
        : app === "WITHOUT_APP" || page.length === 0
          ? new Set<string>()
          : new Set(
              (
                await this.prisma.driver.findMany({
                  where: {
                    AND: [
                      { id: { in: page.map((row) => row.id) } },
                      hasApp(businessId),
                    ],
                  },
                  select: { id: true },
                })
              ).map((row) => row.id),
            );

    return {
      data: page.map((row) => ({
        id: row.id,
        name: row.name,
        hasApp: withAppIds.has(row.id),
      })),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
      hasMore,
    };
  }

  async countAudience(businessId: string): Promise<ChatAudienceCount> {
    const active: Prisma.DriverWhereInput = { businessId, status: "ACTIVE" };

    const [total, withApp] = await Promise.all([
      this.prisma.driver.count({ where: active }),
      this.prisma.driver.count({ where: { AND: [active, hasApp(businessId)] } }),
    ]);

    return { withApp, withoutApp: total - withApp };
  }

  async listAudience(
    businessId: string,
    limit: number,
  ): Promise<ChatBroadcastTarget[]> {
    const rows = await this.prisma.driver.findMany({
      where: { AND: [{ businessId, status: "ACTIVE" }, hasApp(businessId)] },
      select: {
        id: true,
        name: true,
        User: { select: { id: true } },
      },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: limit,
    });

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      appUserId: row.User?.id ?? null,
    }));
  }

  async findRoute(routeId: string): Promise<ChatRouteRef | null> {
    return this.prisma.route.findUnique({
      where: { id: routeId },
      select: ROUTE_REF_SELECT,
    });
  }

  async findRunningRoutes(
    businessId: string,
    driverIds: string[],
  ): Promise<Map<string, ChatRouteRef>> {
    if (driverIds.length === 0) return new Map();

    const rows = await this.prisma.route.findMany({
      where: {
        businessId,
        driverId: { in: driverIds },
        status: "IN_PROGRESS",
      },
      select: ROUTE_REF_SELECT,
      // One running route per driver is the rule; if the data ever says
      // otherwise, the one he left last is where he is.
      orderBy: [
        { started_at: { sort: "desc", nulls: "last" } },
        { created_at: "desc" },
        { id: "desc" },
      ],
    });

    const byDriver = new Map<string, ChatRouteRef>();

    for (const row of rows) {
      if (!byDriver.has(row.driverId)) byDriver.set(row.driverId, row);
    }

    return byDriver;
  }

  async findDeliveryRouteOfDriver(
    businessId: string,
    driverId: string,
    deliveryId: string,
  ): Promise<ChatRouteRef | null> {
    const stops = await this.prisma.routeStop.findMany({
      where: { deliveryId, route: { businessId, driverId } },
      select: {
        route: { select: { ...ROUTE_REF_SELECT, status: true } },
      },
      orderBy: [{ created_at: "desc" }, { id: "desc" }],
    });

    const chosen =
      stops.find((stop) => OPEN_ROUTE_STATUSES.has(stop.route.status)) ??
      stops[0];

    if (!chosen) return null;

    const { status: _status, ...route } = chosen.route;

    return route;
  }
}

export { ChatRepository };
