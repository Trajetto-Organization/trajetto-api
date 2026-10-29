/**
 * Who may watch the operation move, in real time.
 *
 * Pure, and deliberately apart from `websocket.ts`: the same decision has to
 * hold at the handshake, when a MASTER switches company in the selector, and
 * again every time somebody's permissions change while they are connected.
 * Three call sites is three chances to drift, and what drifts here is who can
 * see where every driver in a fleet is standing.
 *
 * The room this guards used to be `business:${businessId}`, which every
 * authenticated user with a company joined unconditionally. Two of the events
 * emitted into it — `routeEvent` and `driverPosition` — are the manager's
 * view of the whole operation, so a driver, a mechanic with only
 * `fuel_manage`, and anyone else with a login received every colleague's GPS
 * coordinates for the length of their session. The HTTP side had refused the
 * same data all along (`/route/control-tower` is `delivery_manage:read` plus
 * an explicit driver refusal); the socket simply never asked.
 *
 * `business:` still exists and still holds everyone — it carries the signals
 * that really are company-wide: a security action, a plan change, a
 * notification. Only the operational feed moved.
 */

import { UserRole } from "@/modules/user/dtos/user-dto";

/** The realtime room of one company's operation. */
function operationsRoom(businessId: string): string {
  return `operations:${businessId}`;
}

interface DeliveryPrincipal {
  /** Resolved at the authenticated handshake, never from a payload. */
  role: UserRole | string | null | undefined;

  /** Set when this user is also a driver. */
  driverId: string | null | undefined;

  /** The company they belong to. NULL for a MASTER. */
  businessId: string | null | undefined;

  permissions:
    | Array<{ permissionKey: string; canRead: boolean }>
    | null
    | undefined;
}

/**
 * Whether this person is on the dispatch side of the counter.
 *
 * The same shape the control tower enforces over HTTP, in one place:
 *
 * - a driver never qualifies, whatever else they hold. The app's permission
 *   table hands every driver `delivery_manage` read and write so they can work
 *   their own day, and reading that key as "may watch everybody" is precisely
 *   how the leak happened;
 * - a MASTER always qualifies. They belong to no company and work over the one
 *   picked in the interface, so company membership cannot be part of their
 *   check — requiring it is what used to leave the master out of every room;
 * - everyone else needs a company of their own, and either BUSINESS_ADMIN or
 *   `delivery_manage` with read.
 */
function mayReadDeliveries(principal: DeliveryPrincipal): boolean {
  if (principal.driverId) return false;

  if (principal.role === "MASTER") return true;

  if (!principal.businessId) return false;

  if (principal.role === "BUSINESS_ADMIN") return true;

  return Boolean(
    principal.permissions?.some(
      (permission) =>
        permission.permissionKey === "delivery_manage" && permission.canRead,
    ),
  );
}

interface OperationsSubscriber {
  role: UserRole | string | null | undefined;
  businessId: string | null | undefined;

  /** Already resolved by `mayReadDeliveries` at the handshake. */
  isDeliveryStaff: boolean | undefined;
}

/**
 * Whether this socket may join a given company's operations room.
 *
 * Mirrors the chat rule on purpose — a MASTER may follow whichever company
 * they have selected; everybody else is pinned to their own, and only from
 * the dispatch side.
 */
function canWatchOperationsOf(
  subscriber: OperationsSubscriber,
  businessId: string,
): boolean {
  if (!businessId) return false;

  if (subscriber.role === "MASTER") return true;

  return Boolean(
    subscriber.isDeliveryStaff &&
      subscriber.businessId &&
      subscriber.businessId === businessId,
  );
}

/** The shape of every company id this product issues (uuid v4/v7). */
const BUSINESS_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A uuid is 36 characters; anything much longer is not worth trimming. */
const MAX_BUSINESS_ID_PAYLOAD = 64;

/**
 * The company an operations subscription names — a uuid, or nothing (RT-1).
 *
 * It becomes part of a room name, and a room name is published through Redis
 * with every emit. The shared reader accepted any string up to the frame
 * ceiling (16 KB), so a MASTER socket could join `operations:<anything>`.
 * Lower-cased because the rooms are named from database ids, which are.
 */
function readOperationsBusinessId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;

  const { businessId } = payload as { businessId?: unknown };

  if (typeof businessId !== "string") return null;
  if (businessId.length > MAX_BUSINESS_ID_PAYLOAD) return null;

  const trimmed = businessId.trim();

  return BUSINESS_ID_PATTERN.test(trimmed) ? trimmed.toLowerCase() : null;
}

export {
  operationsRoom,
  mayReadDeliveries,
  canWatchOperationsOf,
  readOperationsBusinessId,
};
export type { DeliveryPrincipal, OperationsSubscriber };
