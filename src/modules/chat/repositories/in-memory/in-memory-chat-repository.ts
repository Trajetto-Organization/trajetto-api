import { randomUUID } from "node:crypto";

import { IChatRepository } from "../IChat-repository";
import {
  ChatDeliverySide,
  ChatMessage,
  ChatMessageSearchHit,
  ChatMessageView,
  ChatThread,
  CreateChatMessageProps,
  ListChatMessagesProps,
  ListChatMessagesResult,
  ListChatThreadsProps,
  ListChatThreadsResult,
  SearchChatMessagesProps,
} from "../../dtos/chat-dto";

interface ReadRow {
  threadId: string;
  userId: string;
  last_read_at: Date;
}

/** Newest first, id as tiebreaker — the same order the cursor paginates. */
function byNewestFirst(a: ChatMessage, b: ChatMessage): number {
  const byDate = b.created_at.getTime() - a.created_at.getTime();

  return byDate !== 0 ? byDate : b.id.localeCompare(a.id);
}

/** Mirrors the SQL repository: past this the badge only says "99+". */
const UNREAD_DISPLAY_CAP = 100;

class InMemoryChatRepository implements IChatRepository {
  public threads: ChatThread[] = [];
  public messages: ChatMessage[] = [];
  public reads: ReadRow[] = [];

  // Seeded by the tests so views resolve names without a database.
  public driverDirectory = new Map<string, { name: string; cnh: string }>();
  public userDirectory = new Map<
    string,
    { name: string; driverId: string | null; last_seen_at?: Date | null }
  >();
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

  private toView(message: ChatMessage): ChatMessageView {
    const sender = this.userDirectory.get(message.senderId);
    const delivery = message.deliveryId
      ? this.deliveryDirectory.get(message.deliveryId)
      : undefined;

    return {
      ...message,
      sender: { id: message.senderId, name: sender?.name ?? "" },
      delivery:
        message.deliveryId && delivery
          ? { id: message.deliveryId, ...delivery }
          : null,
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
    const existing = await this.findThreadByDriver(businessId, driverId);

    if (existing) return existing;

    const thread: ChatThread = {
      id: randomUUID(),
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

    const sorted = [...scoped].sort((a, b) => {
      const aTime = a.last_message_at?.getTime() ?? -1;
      const bTime = b.last_message_at?.getTime() ?? -1;

      return bTime - aTime;
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
  }: ListChatMessagesProps): Promise<ListChatMessagesResult> {
    const normalizedSearch = search?.trim().toLowerCase() ?? "";

    /** Negative when a is older than b — the cursor's total order. */
    const compare = (
      a: { created_at: Date; id: string },
      b: { created_at: Date; id: string },
    ): number => {
      const byDate = a.created_at.getTime() - b.created_at.getTime();

      return byDate !== 0 ? byDate : a.id.localeCompare(b.id);
    };

    const scoped = this.messages.filter((message) => {
      if (message.threadId !== threadId) return false;

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
    const message: ChatMessage = {
      id: randomUUID(),
      kind: props.kind,
      body: props.body,
      attachment_key: props.attachment_key,
      duration_ms: props.duration_ms,
      deliveryId: props.deliveryId,
      broadcast_id: props.broadcast_id,
      client_submission_id: props.client_submission_id,
      threadId: props.threadId,
      senderId: props.senderId,
      created_at: new Date(),
    };

    this.messages.push(message);

    const thread = this.threads.find((row) => row.id === props.threadId);

    if (thread) {
      thread.last_message_at = message.created_at;
    }

    return message;
  }

  async findMessageById(messageId: string): Promise<ChatMessage | null> {
    return this.messages.find((message) => message.id === messageId) ?? null;
  }

  async findMessageBySubmissionId(
    clientSubmissionId: string,
    businessId: string,
  ): Promise<ChatMessage | null> {
    /**
     * O escopo também aqui.
     *
     * Um fake que aceita o parâmetro e o ignora é pior que um fake que não o
     * aceita: o TypeScript deixa passar (um método com menos parâmetros é
     * atribuível), e o teste unitário fica verde com o furo aberto. Foi assim
     * que a chave de idempotência do chat virou credencial e ninguém viu.
     */
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
}

export { InMemoryChatRepository };
