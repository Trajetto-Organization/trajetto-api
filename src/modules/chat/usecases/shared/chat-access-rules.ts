import { UserRole } from "@/modules/user/dtos/user-dto";

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
 * The only thing read out of a `chatSubscribe`/`chatUnsubscribe` payload.
 * Anything that is not a non-empty string business id becomes null, and the
 * caller ignores the event silently — a malformed frame is never a reason to
 * drop a connection.
 */
function readBusinessIdPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;

  const { businessId } = payload as { businessId?: unknown };

  if (typeof businessId !== "string") return null;

  const trimmed = businessId.trim();

  return trimmed.length > 0 ? trimmed : null;
}

export {
  chatStaffRoom,
  canWriteInChat,
  canSubscribeToChatBusiness,
  readBusinessIdPayload,
};
export type { ChatSubscriber };
