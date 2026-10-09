// uuid v7 like the columns' @default(uuid(7)): the id breaks created_at ties
// in creation order, as the (created_at, id) orderings expect.
import { v7 as uuidV7 } from "uuid";

import { Prisma } from "@prisma/client";

import { CHAT_MESSAGE_COLUMN_DEFAULTS } from "@/shared/in-memory/column-defaults";
import { compareCodePoints } from "@/shared/pagination/in-memory-order";

import { ChatRouteRef, IChatRepository } from "../IChat-repository";
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
} from "../../dtos/chat-dto";

/** A route row, as far as the chat reads it. */
interface RouteRow {
  id: string;
  businessId: string;
  driverId: string;
  code: number;
  name: string | null;
  status: "PLANNED" | "RELEASED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
  started_at: Date | null;
  created_at: Date;
}

/** A stop, as far as the chat reads it: which route carries which delivery. */
interface RouteStopRow {
  id: string;
  routeId: string;
  deliveryId: string;
  created_at: Date;
}

function routeRef(route: RouteRow): ChatRouteRef {
  return {
    id: route.id,
    businessId: route.businessId,
    driverId: route.driverId,
    code: route.code,
    name: route.name,
  };
}

/**
 * Same total order as the SQL repository's `ORDER BY name, id`: code point,
 * the collation of the deployed postgres:16-alpine (see compareCodePoints).
 * localeCompare("en-US") put "Ágata" next to "ana", where Postgres never does.
 */
function byNameThenId(
  a: { name: string; id: string },
  b: { name: string; id: string },
): number {
  const byName = compareCodePoints(a.name, b.name);

  return byName !== 0 ? byName : compareCodePoints(a.id, b.id);
}

interface ReadRow {
  threadId: string;
  userId: string;
  last_read_at: Date;
}

/** Newest first, id as tiebreaker — the same order the cursor paginates. */
function byNewestFirst(a: ChatMessage, b: ChatMessage): number {
  const byDate = b.created_at.getTime() - a.created_at.getTime();

  return byDate !== 0 ? byDate : compareCodePoints(b.id, a.id);
}

/** P2003, as Postgres answers a row pointing at a thread that does not exist. */
function missingThread(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    "Foreign key constraint violated on the foreign key",
    { code: "P2003", clientVersion: "in-memory", meta: { field_name: "threadId" } },
  );
}

/** Mirrors the SQL repository: past this the badge only says "99+". */
const UNREAD_DISPLAY_CAP = 100;

class InMemoryChatRepository implements IChatRepository {
  public threads: ChatThread[] = [];
  public messages: ChatMessage[] = [];
  public reads: ReadRow[] = [];

  // Seeded by the tests so views resolve names without a database. A driver
  // is a chat RECIPIENT only when the test says which company he is in and
  // that he is active — the SQL filters on both, so the twin does too.
  public driverDirectory = new Map<
    string,
    {
      name: string;
      cnh: string;
      businessId?: string;
      status?: "ACTIVE" | "INACTIVE";

      /** The driver's branch; absent or null = no branch (branchId null). */
      branch?: { is_active: boolean } | null;
    }
  >();
  public userDirectory = new Map<
    string,
    {
      name: string;
      driverId: string | null;
      last_seen_at?: Date | null;
      access_revoked?: boolean;

      /** Checked against the driver's company when a test seeds it. */
      businessId?: string | null;
    }
  >();

  public routes: RouteRow[] = [];
  public routeStops: RouteStopRow[] = [];
  public deliveryDirectory = new Map<
    string,
    { recipient_name: string; status: string }
  >();

  private driverUserId(driverId: string): string | null {
    for (const [userId, user] of this.userDirectory) {
      if (user.driverId === driverId) return userId;
    }

    return null;
  }

  /**
   * The driver's app account that can read, as the SQL `hasApp` decides it:
   * not revoked, of the driver's company, and the driver's branch (if any)
   * active.
   */
  private appUserOf(driverId: string): string | null {
    const driver = this.driverDirectory.get(driverId);

    if (driver?.branch && !driver.branch.is_active) return null;

    for (const [userId, user] of this.userDirectory) {
      if (user.driverId !== driverId || user.access_revoked) continue;

      if (
        user.businessId !== undefined &&
        driver?.businessId !== undefined &&
        user.businessId !== driver.businessId
      ) {
        continue;
      }

      return userId;
    }

    return null;
  }

  private toView(message: ChatMessage): ChatMessageView {
    const sender = this.userDirectory.get(message.senderId);
    const delivery = message.deliveryId
      ? this.deliveryDirectory.get(message.deliveryId)
      : undefined;
    const route = message.routeId
      ? this.routes.find((row) => row.id === message.routeId)
      : undefined;

    return {
      ...message,
      sender: { id: message.senderId, name: sender?.name ?? "" },
      delivery:
        message.deliveryId && delivery
          ? { id: message.deliveryId, ...delivery }
          : null,
      route: route ? { id: route.id, code: route.code, name: route.name } : null,
    };
  }

  async findThreadById(threadId: string): Promise<ChatThread | null> {
    return this.threads.find((thread) => thread.id === threadId) ?? null;
  }

  async findThreadByDriver(
    businessId: string,
    driverId: string,
  ): Promise<ChatThread | null> {
    return (
      this.threads.find(
        (thread) =>
          thread.businessId === businessId && thread.driverId === driverId,
      ) ?? null
    );
  }

  async getOrCreateThread(
    businessId: string,
    driverId: string,
  ): Promise<ChatThread> {
    // Checked and inserted with no await in between, like the SQL's single
    // ON CONFLICT DO NOTHING: two first messages racing converge on one
    // thread. With an await here both saw "none" and made two.
    const existing = this.threads.find(
      (thread) =>
        thread.businessId === businessId && thread.driverId === driverId,
    );

    if (existing) return existing;

    const thread: ChatThread = {
      id: uuidV7(),
      businessId,
      driverId,
      last_message_at: null,
      driver_delivered_at: null,
      staff_delivered_at: null,
      created_at: new Date(),
    };

    this.threads.push(thread);
    return thread;
  }

  private unreadCount(thread: ChatThread, requesterUserId: string): number {
    const cursor = this.reads.find(
      (row) => row.threadId === thread.id && row.userId === requesterUserId,
    );

    const driverUserId = this.driverUserId(thread.driverId);
    const requesterIsDriverSide = requesterUserId === driverUserId;

    const unread = this.messages.filter((message) => {
      if (message.threadId !== thread.id) return false;

      if (cursor && message.created_at <= cursor.last_read_at) return false;

      // Only the OTHER side's messages count as unread.
      return requesterIsDriverSide
        ? message.senderId !== requesterUserId
        : driverUserId !== null && message.senderId === driverUserId;
    }).length;

    // Capped like the SQL repository, and for the same reason: the badge
    // draws "99+" past ninety-nine, so a test that asserted 4,312 here would
    // be asserting a number the product cannot show.
    return Math.min(unread, UNREAD_DISPLAY_CAP);
  }

  async listThreads({
    businessId,
    requesterUserId,
    driverId,
    search,
    page,
    pageSize,
  }: ListChatThreadsProps): Promise<ListChatThreadsResult> {
    const normalizedSearch = search?.trim().toLowerCase() ?? "";

    const scoped = this.threads.filter((thread) => {
      if (thread.businessId !== businessId) return false;
      if (driverId && thread.driverId !== driverId) return false;

      if (normalizedSearch) {
        const driver = this.driverDirectory.get(thread.driverId);
        if (!driver?.name.toLowerCase().includes(normalizedSearch)) {
          return false;
        }
      }

      return true;
    });

    // Same order as the SQL: last_message_at desc with never-written threads
    // last, then the newest thread first. Without the second key two threads
    // nobody wrote to came out oldest first here and newest first in SQL.
    const sorted = [...scoped].sort((a, b) => {
      const aTime = a.last_message_at?.getTime() ?? -Infinity;
      const bTime = b.last_message_at?.getTime() ?? -Infinity;

      if (aTime !== bTime) return bTime > aTime ? 1 : -1;

      const byCreated = b.created_at.getTime() - a.created_at.getTime();

      // The id closes the order, as in SQL: without it two threads created in
      // the same instant could swap between pages.
      return byCreated !== 0 ? byCreated : compareCodePoints(b.id, a.id);
    });

    const pageRows = sorted.slice((page - 1) * pageSize, page * pageSize);

    const data = pageRows.map((thread) => {
      const driver = this.driverDirectory.get(thread.driverId);
      const driverUserId = this.driverUserId(thread.driverId);
      const driverUser = driverUserId
        ? this.userDirectory.get(driverUserId)
        : undefined;

      const lastMessage = this.messages
        .filter((message) => message.threadId === thread.id)
        .sort(byNewestFirst)[0];

      return {
        id: thread.id,
        driver: {
          id: thread.driverId,
          name: driver?.name ?? "",
          cnh: driver?.cnh ?? "",
        },
        driverUser:
          driverUserId && driverUser
            ? { id: driverUserId, last_seen_at: driverUser.last_seen_at ?? null }
            : null,
        lastMessage: lastMessage
          ? {
              kind: lastMessage.kind,
              body: lastMessage.body,
              sender: {
                id: lastMessage.senderId,
                name: this.userDirectory.get(lastMessage.senderId)?.name ?? "",
              },
              created_at: lastMessage.created_at,
            }
          : null,
        unreadCount: this.unreadCount(thread, requesterUserId),
      };
    });

    const totalUnread = Math.min(
      scoped.reduce(
        (sum, thread) => sum + this.unreadCount(thread, requesterUserId),
        0,
      ),
      UNREAD_DISPLAY_CAP,
    );

    return { data, total: scoped.length, totalUnread };
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
    const normalizedSearch = search?.trim().toLowerCase() ?? "";

    /** Negative when a is older than b — the cursor's total order. */
    const compare = (
      a: { created_at: Date; id: string },
      b: { created_at: Date; id: string },
    ): number => {
      const byDate = a.created_at.getTime() - b.created_at.getTime();

      return byDate !== 0 ? byDate : compareCodePoints(a.id, b.id);
    };

    const scoped = this.messages.filter((message) => {
      if (message.threadId !== threadId) return false;

      if (deliveryId && message.deliveryId !== deliveryId) return false;
      if (routeId && message.routeId !== routeId) return false;
      if (ticketId && message.ticketId !== ticketId) return false;

      if (
        normalizedSearch &&
        !message.body?.toLowerCase().includes(normalizedSearch)
      ) {
        return false;
      }

      return true;
    });

    const cursors = {
      counterpartLastReadAt: this.counterpartLastReadAt(
        threadId,
        viewerIsDriverSide,
      ),
      counterpartDeliveredAt: this.counterpartDeliveredAt(
        threadId,
        viewerIsDriverSide,
      ),
    };

    const answer = (
      data: ChatMessage[],
      hasOlder: boolean,
      hasNewer: boolean,
    ): ListChatMessagesResult => {
      const newest = data[0];
      const oldest = data[data.length - 1];

      return {
        data: data.map((message) => this.toView(message)),
        nextCursor:
          hasOlder && oldest
            ? { created_at: oldest.created_at.toISOString(), id: oldest.id }
            : null,
        previousCursor:
          hasNewer && newest
            ? { created_at: newest.created_at.toISOString(), id: newest.id }
            : null,
        hasNewer,
        ...cursors,
      };
    };

    // ------------------------------------------------ centred on a message
    if (around) {
      const newerCount = Math.floor(limit / 2);
      const olderCount = Math.max(1, limit - newerCount);

      const newer = scoped
        .filter((message) => compare(message, around) > 0)
        .sort((a, b) => compare(a, b));

      const olderIncludingAnchor = scoped
        .filter((message) => compare(message, around) <= 0)
        .sort((a, b) => compare(b, a));

      const hasNewer = newer.length > newerCount;
      const hasOlder = olderIncludingAnchor.length > olderCount;

      const data = [...newer.slice(0, newerCount)]
        .reverse()
        .concat(olderIncludingAnchor.slice(0, olderCount));

      return answer(data, hasOlder, hasNewer);
    }

    // ------------------------------------------------- walking forward
    if (after) {
      const rows = scoped
        .filter((message) => compare(message, after) > 0)
        .sort((a, b) => compare(a, b));

      const hasNewer = rows.length > limit;

      return answer([...rows.slice(0, limit)].reverse(), false, hasNewer);
    }

    // ------------------------------------------- the end of the thread
    const rows = scoped
      .filter((message) => !before || compare(message, before) < 0)
      .sort(byNewestFirst);

    const hasMore = rows.length > limit;

    return answer(rows.slice(0, limit), hasMore, false);
  }

  private counterpartDeliveredAt(
    threadId: string,
    viewerIsDriverSide: boolean,
  ): Date | null {
    const thread = this.threads.find((row) => row.id === threadId);

    if (!thread) return null;

    // Each side sees the OTHER side's cursor: the driver learns that an
    // agent's panel has the message, the agent that the phone has it.
    return viewerIsDriverSide
      ? (thread.staff_delivered_at ?? null)
      : (thread.driver_delivered_at ?? null);
  }

  private counterpartLastReadAt(
    threadId: string,
    viewerIsDriverSide: boolean,
  ): Date | null {
    const thread = this.threads.find((row) => row.id === threadId);

    if (!thread) return null;

    const driverUserId = this.driverUserId(thread.driverId);

    const cursors = this.reads.filter((row) => {
      if (row.threadId !== threadId) return false;

      return viewerIsDriverSide
        ? row.userId !== driverUserId
        : row.userId === driverUserId;
    });

    if (cursors.length === 0) return null;

    return cursors.reduce(
      (latest, row) => (row.last_read_at > latest ? row.last_read_at : latest),
      cursors[0].last_read_at,
    );
  }

  async searchMessages({
    businessId,
    search,
    limit,
    driverId,
  }: SearchChatMessagesProps): Promise<ChatMessageSearchHit[]> {
    const normalizedSearch = search.trim().toLowerCase();

    if (!normalizedSearch) return [];

    const threadById = new Map(
      this.threads.map((thread) => [thread.id, thread]),
    );

    return this.messages
      .filter((message) => {
        const thread = threadById.get(message.threadId);

        if (!thread || thread.businessId !== businessId) return false;
        if (driverId && thread.driverId !== driverId) return false;

        return message.body?.toLowerCase().includes(normalizedSearch) ?? false;
      })
      .sort(byNewestFirst)
      .slice(0, limit)
      .map((message) => {
        const thread = threadById.get(message.threadId)!;
        const driver = this.driverDirectory.get(thread.driverId);

        return {
          ...this.toView(message),
          driver: { id: thread.driverId, name: driver?.name ?? "" },
        };
      });
  }

  async createMessage(
    props: CreateChatMessageProps,
    _tx?: unknown,
  ): Promise<ChatMessage> {
    // The column is UNIQUE across every company, and Postgres answers a
    // second insert of the same key with P2002. The twin used to accept it,
    // so the race two replicas run with one key could not be tested here.
    if (
      props.client_submission_id !== null &&
      this.messages.some(
        (message) =>
          message.client_submission_id === props.client_submission_id,
      )
    ) {
      throw new Prisma.PrismaClientKnownRequestError(
        "Unique constraint failed on the fields: (`client_submission_id`)",
        { code: "P2002", clientVersion: "in-memory" },
      );
    }

    const thread = this.threads.find((row) => row.id === props.threadId);

    // The thread's foreign key: the twin used to store an orphan message.
    if (!thread) throw missingThread();

    const message: ChatMessage = {
      ...CHAT_MESSAGE_COLUMN_DEFAULTS,
      id: uuidV7(),
      kind: props.kind,
      body: props.body,
      attachment_key: props.attachment_key,
      duration_ms: props.duration_ms,
      deliveryId: props.deliveryId,
      routeId: props.routeId ?? null,
      broadcast_id: props.broadcast_id,
      client_submission_id: props.client_submission_id,
      threadId: props.threadId,
      senderId: props.senderId,
      ticketId: props.ticketId ?? null,
      created_at: new Date(),
    };

    this.messages.push(message);
    thread.last_message_at = message.created_at;

    return message;
  }

  async findMessageById(messageId: string): Promise<ChatMessage | null> {
    return this.messages.find((message) => message.id === messageId) ?? null;
  }

  async findMessageBySubmissionId(
    clientSubmissionId: string,
    businessId: string,
  ): Promise<ChatMessage | null> {
    // Scoped here too: a twin that accepts `businessId` and ignores it
    // type-checks and keeps a unit test green over a cross-tenant leak.
    const message = this.messages.find(
      (entry) => entry.client_submission_id === clientSubmissionId,
    );

    if (!message) return null;

    const thread = this.threads.find((entry) => entry.id === message.threadId);

    return thread?.businessId === businessId ? message : null;
  }

  async markThreadRead(
    threadId: string,
    userId: string,
    at: Date,
  ): Promise<void> {
    const existing = this.reads.find(
      (row) => row.threadId === threadId && row.userId === userId,
    );

    if (!existing) {
      // The SQL inserts the first cursor, and the thread's foreign key
      // refuses one for a thread that does not exist.
      if (!this.threads.some((row) => row.id === threadId)) {
        throw missingThread();
      }

      this.reads.push({ threadId, userId, last_read_at: at });
      return;
    }

    // Advance-only, mirroring the SQL repository.
    if (existing.last_read_at < at) {
      existing.last_read_at = at;
    }
  }

  async markThreadDelivered(
    threadId: string,
    at: Date,
    side: ChatDeliverySide,
  ): Promise<void> {
    const thread = this.threads.find((row) => row.id === threadId);

    if (!thread) return;

    // Advance-only, mirroring the SQL repository: an out-of-order receipt
    // cannot undeliver what a device already holds.
    if (side === "DRIVER") {
      if (!thread.driver_delivered_at || thread.driver_delivered_at < at) {
        thread.driver_delivered_at = at;
      }

      return;
    }

    if (!thread.staff_delivered_at || thread.staff_delivered_at < at) {
      thread.staff_delivered_at = at;
    }
  }

  /** Active drivers of one company, as the SQL's WHERE picks them. */
  private activeDriversOf(businessId: string) {
    return [...this.driverDirectory.entries()]
      .filter(
        ([, driver]) =>
          driver.businessId === businessId && driver.status === "ACTIVE",
      )
      .map(([id, driver]) => ({
        id,
        name: driver.name,
        appUserId: this.appUserOf(id),
      }));
  }

  async listRecipients({
    businessId,
    search,
    app,
    cursor,
    limit,
  }: ListChatRecipientsProps): Promise<ListChatRecipientsResult> {
    const term = search?.trim().toLowerCase() ?? "";

    const ordered = this.activeDriversOf(businessId)
      .filter((driver) => {
        if (app === "WITH_APP" && !driver.appUserId) return false;
        if (app === "WITHOUT_APP" && driver.appUserId) return false;

        // By name only, like the SQL: the CNH is not the chat's to match on.
        return !term || driver.name.toLowerCase().includes(term);
      })
      .sort(byNameThenId);

    // Keyset after the anchor, like the SQL: the anchor is looked up by id
    // inside the company and WITHOUT the list's filter, so a driver made
    // inactive between two pages neither ends the list nor hides the next
    // colleague. Positioned by its current name, as in the SQL. Nothing
    // when the anchor is gone.
    const anchor = cursor ? this.driverDirectory.get(cursor) : undefined;

    const rows = !cursor
      ? ordered.slice(0, limit + 1)
      : !anchor || anchor.businessId !== businessId
        ? []
        : ordered
            .filter(
              (driver) =>
                byNameThenId(driver, { id: cursor, name: anchor.name }) > 0,
            )
            .slice(0, limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    return {
      data: page.map((driver) => ({
        id: driver.id,
        name: driver.name,
        hasApp: driver.appUserId !== null,
      })),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
      hasMore,
    };
  }

  async countAudience(businessId: string): Promise<ChatAudienceCount> {
    const active = this.activeDriversOf(businessId);
    const withApp = active.filter((driver) => driver.appUserId).length;

    return { withApp, withoutApp: active.length - withApp };
  }

  async listAudience(
    businessId: string,
    limit: number,
  ): Promise<ChatBroadcastTarget[]> {
    return this.activeDriversOf(businessId)
      .filter((driver) => driver.appUserId !== null)
      .sort(byNameThenId)
      .slice(0, limit)
      .map(({ id, name, appUserId }) => ({ id, name, appUserId }));
  }

  async findRoute(routeId: string): Promise<ChatRouteRef | null> {
    const route = this.routes.find((row) => row.id === routeId);

    return route ? routeRef(route) : null;
  }

  async findRunningRoutes(
    businessId: string,
    driverIds: string[],
  ): Promise<Map<string, ChatRouteRef>> {
    const wanted = new Set(driverIds);

    const running = this.routes
      .filter(
        (route) =>
          route.businessId === businessId &&
          wanted.has(route.driverId) &&
          route.status === "IN_PROGRESS",
      )
      .sort((a, b) => {
        // started_at desc, nulls last; then created_at desc; then id desc.
        const aStart = a.started_at?.getTime() ?? -Infinity;
        const bStart = b.started_at?.getTime() ?? -Infinity;

        if (aStart !== bStart) return bStart > aStart ? 1 : -1;

        const byCreated = b.created_at.getTime() - a.created_at.getTime();

        return byCreated !== 0 ? byCreated : compareCodePoints(b.id, a.id);
      });

    const byDriver = new Map<string, ChatRouteRef>();

    for (const route of running) {
      if (!byDriver.has(route.driverId)) {
        byDriver.set(route.driverId, routeRef(route));
      }
    }

    return byDriver;
  }

  async findDeliveryRouteOfDriver(
    businessId: string,
    driverId: string,
    deliveryId: string,
  ): Promise<ChatRouteRef | null> {
    const routeById = new Map(this.routes.map((route) => [route.id, route]));

    const stops = this.routeStops
      .filter((stop) => {
        const route = routeById.get(stop.routeId);

        return (
          stop.deliveryId === deliveryId &&
          route?.businessId === businessId &&
          route.driverId === driverId
        );
      })
      .sort((a, b) => {
        const byCreated = b.created_at.getTime() - a.created_at.getTime();

        return byCreated !== 0 ? byCreated : compareCodePoints(b.id, a.id);
      });

    const open = stops.find((stop) => {
      const status = routeById.get(stop.routeId)?.status;

      return status === "RELEASED" || status === "IN_PROGRESS";
    });

    const chosen = open ?? stops[0];
    const route = chosen ? routeById.get(chosen.routeId) : undefined;

    return route ? routeRef(route) : null;
  }
}

export { InMemoryChatRepository };
