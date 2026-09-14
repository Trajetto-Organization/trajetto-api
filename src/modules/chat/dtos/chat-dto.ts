type ChatMessageKind = "TEXT" | "IMAGE" | "AUDIO";

/**
 * Which counter confirmed receipt. The two sides are not symmetric in
 * nature — one is a phone, the other a team of open panels — but they are
 * symmetric in meaning: "a real device on that side already has it".
 */
type ChatDeliverySide = "DRIVER" | "STAFF";

interface ChatThread {
  id: string;
  businessId: string;
  driverId: string;
  last_message_at: Date | null;

  /**
   * How far this thread's driver device has already received. Only the
   * driver side has one: for the staff, reaching the server IS reaching the
   * base, so there is no "delivered" state to store.
   */
  driver_delivered_at: Date | null;
  staff_delivered_at: Date | null;

  created_at: Date;
}

interface ChatMessage {
  id: string;
  kind: ChatMessageKind;
  body: string | null;
  attachment_key: string | null;
  duration_ms: number | null;
  deliveryId: string | null;
  broadcast_id: string | null;
  client_submission_id: string | null;
  threadId: string;
  senderId: string;
  created_at: Date;
}

/** A message as the conversation screen consumes it. */
interface ChatMessageView extends ChatMessage {
  sender: { id: string; name: string };

  /** The context chip — resolved so the UI never joins on its side. */
  delivery: { id: string; recipient_name: string; status: string } | null;
}

interface ChatThreadListEntry {
  id: string;
  driver: { id: string; name: string; cnh: string };

  /**
   * The driver's app account. Null when the driver has no user yet — the
   * SAC can still write; the thread waits for the account to exist.
   * last_seen_at feeds "visto por último"; live presence rides the socket.
   */
  driverUser: { id: string; last_seen_at: Date | null } | null;

  lastMessage: {
    kind: ChatMessageKind;
    body: string | null;
    sender: { id: string; name: string };
    created_at: Date;
  } | null;

  /** Messages from the other side newer than the requester's read cursor. */
  unreadCount: number;
}

interface ListChatThreadsProps {
  businessId: string;
  requesterUserId: string;

  /** Driver token: restricted to their own thread. */
  driverId?: string;

  /** Matches the driver's name. */
  search?: string;

  page: number;
  pageSize: number;
}

interface ListChatThreadsResult {
  data: ChatThreadListEntry[];
  total: number;

  /** Across every thread of the scope, not only the page — the tab badge. */
  totalUnread: number;
}

interface ListChatMessagesProps {
  threadId: string;

  /**
   * Which side is looking, so counterpartLastReadAt reads the OTHER side's
   * cursor: the driver's for staff, the most advanced staff one for the
   * driver.
   */
  viewerIsDriverSide: boolean;

  /** Exclusive cursor: only messages strictly older than this point. */
  before?: { created_at: Date; id: string };

  /** Exclusive cursor the other way: only messages strictly newer. */
  after?: { created_at: Date; id: string };

  /**
   * Centre the page on this message instead of on the end of the thread.
   *
   * What "jump to this message" needs. Paging backwards to reach a hit from
   * last March would mean dozens of round trips and a megabyte of history the
   * reader never asked for; two indexed queries around a known point cost the
   * same as one page.
   */
  around?: { created_at: Date; id: string };

  limit: number;

  /** Filters the thread's history by text. */
  search?: string;
}

interface ListChatMessagesResult {
  /** Newest first — the client renders bottom-up. */
  data: ChatMessageView[];

  nextCursor: { created_at: string; id: string } | null;

  /**
   * The cursor towards the PRESENT, and whether anything is out there.
   *
   * Null when this page already reaches the end of the thread. A window
   * centred on an old message does not, so the reader needs both a way to
   * walk forward and an honest "jump to the latest" affordance — a thread
   * that silently stops short of its newest message is how a dispatcher
   * misses a reply.
   */
  previousCursor: { created_at: string; id: string } | null;
  hasNewer: boolean;

  /**
   * How far the OTHER side has read (the driver's cursor for a staff
   * viewer; the most advanced staff cursor for the driver). Messages at or
   * before this instant render the double check.
   */
  counterpartLastReadAt: Date | null;

  /**
   * How far the driver's device has received — the grey double check, only
   * for a staff viewer. Always null for the driver: the base is the server,
   * so a message that reached it has already arrived.
   */
  counterpartDeliveredAt: Date | null;
}

/** A cross-thread search hit, with enough context to jump into the thread. */
interface ChatMessageSearchHit extends ChatMessageView {
  driver: { id: string; name: string };
}

interface SearchChatMessagesProps {
  businessId: string;
  search: string;
  limit: number;

  /** Driver token: restricted to their own thread. */
  driverId?: string;
}

interface CreateChatMessageProps {
  threadId: string;
  senderId: string;
  kind: ChatMessageKind;
  body: string | null;
  attachment_key: string | null;
  duration_ms: number | null;
  deliveryId: string | null;
  broadcast_id: string | null;
  client_submission_id: string | null;
}

export type {
  ChatMessageKind,
  ChatThread,
  ChatMessage,
  ChatMessageView,
  ChatThreadListEntry,
  ListChatThreadsProps,
  ListChatThreadsResult,
  ListChatMessagesProps,
  ListChatMessagesResult,
  ChatMessageSearchHit,
  SearchChatMessagesProps,
  CreateChatMessageProps,
  ChatDeliverySide,
};
