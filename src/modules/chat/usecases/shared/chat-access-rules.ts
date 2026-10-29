import { UserRole } from "@/modules/user/dtos/user-dto";
import { readOperationsBusinessId } from "@/shared/socket/operations-access";

/**
 * Pure access rules for the driver chat.
 *
 * They are pure on purpose: the same decision has to hold on the HTTP side
 * (use cases) and on the socket side (room subscription and typing relay),
 * and both are tested without a server.
 */

/** The SAC team room of one company. */
function chatStaffRoom(businessId: string): string {
  return `chat-staff:${businessId}`;
}

/**
 * One driver's own chat room, named after the company they belong to.
 *
 * The staff's typing hints are addressed to a user id the client sends. They
 * used to go out through a cluster-wide `fetchSockets` per keystroke, only to
 * filter the answer by company. With the company in the room name — the
 * SENDER's company, from its handshake — a hint aimed at another tenant's
 * driver goes to a room nobody is in, with no round trip at all.
 */
function chatDriverRoom(businessId: string, userId: string): string {
  return `chat-driver:${businessId}:${userId}`;
}

/**
 * Who may put words inside a conversation.
 *
 * The driver app labels every message that is not the driver's own as "the
 * base" — the company's own operation. A MASTER is the software vendor, not
 * the customer's operation: letting them write would make the vendor speak
 * as the customer in front of the driver. The master seat exists for support
 * and diagnosis, so it reads and never writes.
 */
function canWriteInChat(role: UserRole | string | null | undefined): boolean {
  return Boolean(role) && role !== "MASTER";
}

interface ChatSubscriber {
  /** Role resolved at the authenticated handshake — never from a payload. */
  role: UserRole | string | null | undefined;

  /** The company the user belongs to. NULL for a MASTER. */
  businessId: string | null | undefined;

  /** Already resolved SAC side: not a driver and may read deliveries. */
  isChatStaff: boolean | undefined;
}

/**
 * Whether this socket may listen to a company's chat room.
 *
 * A MASTER has no company of their own and operates over the one selected in
 * the interface, so they may subscribe to any company. Everyone else is
 * pinned to their own company, and only on the SAC side of the counter — a
 * driver's socket must never hear the whole company's conversations.
 */
function canSubscribeToChatBusiness(
  subscriber: ChatSubscriber,
  businessId: string,
): boolean {
  if (!businessId) return false;

  if (subscriber.role === "MASTER") return true;

  return Boolean(
    subscriber.isChatStaff &&
      subscriber.businessId &&
      subscriber.businessId === businessId,
  );
}

/**
 * The only thing read out of a `chatSubscribe`/`chatUnsubscribe` payload: a
 * company id shaped like one, lower-cased, or null — and the caller ignores
 * the event silently, since a malformed frame is never a reason to drop a
 * connection.
 *
 * The same reader as `operationsSubscribe` (RT-1). It used to accept any
 * non-empty string up to the frame ceiling (16 KB); the id becomes part of a
 * room name, which is published through Redis with every emit.
 */
function readBusinessIdPayload(payload: unknown): string | null {
  return readOperationsBusinessId(payload);
}

/** Longer than any id this product issues, and far short of a padded frame. */
const MAX_DRIVER_USER_ID_LENGTH = 64;

/**
 * The driver a staff hint is addressed to — a short string, or nothing.
 *
 * It becomes part of a room name, and a room name is published through Redis
 * with every emit. Unchecked, a client could make that as large as the whole
 * message ceiling.
 */
function readDriverUserIdPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;

  const { driverUserId } = payload as { driverUserId?: unknown };

  if (typeof driverUserId !== "string") return null;

  const trimmed = driverUserId.trim();

  return trimmed.length > 0 && trimmed.length <= MAX_DRIVER_USER_ID_LENGTH
    ? trimmed
    : null;
}

export {
  chatStaffRoom,
  chatDriverRoom,
  canWriteInChat,
  canSubscribeToChatBusiness,
  readBusinessIdPayload,
  readDriverUserIdPayload,
};
export type { ChatSubscriber };
