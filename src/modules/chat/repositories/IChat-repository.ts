import {
  ChatAudienceCount,
  ChatBroadcastTarget,
  ChatDeliverySide,
  ChatMessage,
  ChatMessageSearchHit,
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

/** A route as the chat needs it to validate and tag a message. */
interface ChatRouteRef {
  id: string;
  businessId: string;
  driverId: string;
  code: number;
  name: string | null;
}

interface IChatRepository {
  findThreadById: (threadId: string) => Promise<ChatThread | null>;
  findThreadByDriver: (
    businessId: string,
    driverId: string,
  ) => Promise<ChatThread | null>;

  /**
   * Upsert on (businessId, driverId): concurrent first messages converge.
   * Takes the caller's transaction so a flow already holding one (the
   * occurrence report) never needs a second pooled connection.
   */
  getOrCreateThread: (
    businessId: string,
    driverId: string,
    tx?: unknown,
  ) => Promise<ChatThread>;

  listThreads: (props: ListChatThreadsProps) => Promise<ListChatThreadsResult>;
  listMessages: (
    props: ListChatMessagesProps,
  ) => Promise<ListChatMessagesResult>;
  searchMessages: (
    props: SearchChatMessagesProps,
  ) => Promise<ChatMessageSearchHit[]>;

  /**
   * Inserts and bumps the thread's last_message_at atomically. Accepts the
   * caller's transaction so the outbox publish can commit with the message.
   */
  createMessage: (
    props: CreateChatMessageProps,
    tx?: unknown,
  ) => Promise<ChatMessage>;
  /**
   * The message already created with this key, WITHIN this company.
   *
   * The column is globally unique; without the `businessId` scope the
   * idempotency key would be a credential: whoever knew another company's
   * key would get that message back, with a fresh signed URL for its media.
   */
  findMessageBySubmissionId: (
    clientSubmissionId: string,
    businessId: string,
  ) => Promise<ChatMessage | null>;
  findMessageById: (messageId: string) => Promise<ChatMessage | null>;

  /** Advances (never rewinds) the requester's read cursor. */
  markThreadRead: (
    threadId: string,
    userId: string,
    at: Date,
  ) => Promise<void>;

  /** Advances (never rewinds) one side's delivery cursor. */
  markThreadDelivered: (
    threadId: string,
    at: Date,
    side: ChatDeliverySide,
  ) => Promise<void>;

  /**
   * Active drivers of one company for the chat pickers, alphabetical, with
   * whether each one can read the thread (an app account not revoked).
   */
  listRecipients: (
    props: ListChatRecipientsProps,
  ) => Promise<ListChatRecipientsResult>;

  /** How many active drivers sit on each side of the app line. */
  countAudience: (businessId: string) => Promise<ChatAudienceCount>;

  /**
   * "Todos os motoristas ativos com o app": every active driver of the
   * company whose account can read the thread. At most `limit` rows: the
   * caller asks one more than it accepts to tell a company that is too
   * large for one notice.
   */
  listAudience: (
    businessId: string,
    limit: number,
  ) => Promise<ChatBroadcastTarget[]>;

  /** A route by id, or null. The caller checks company and driver. */
  findRoute: (routeId: string) => Promise<ChatRouteRef | null>;

  /**
   * The route each driver is running right now (IN_PROGRESS, the one
   * started last), keyed by driver. Drivers with none are absent.
   */
  findRunningRoutes: (
    businessId: string,
    driverIds: string[],
  ) => Promise<Map<string, ChatRouteRef>>;

  /**
   * The route of this driver that carries this delivery: an open one
   * (released or running) first, the newest stop next. Null when the
   * delivery is on none of his routes.
   */
  findDeliveryRouteOfDriver: (
    businessId: string,
    driverId: string,
    deliveryId: string,
  ) => Promise<ChatRouteRef | null>;
}

export { IChatRepository };
export type { ChatRouteRef };
