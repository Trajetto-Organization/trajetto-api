/**
 * The messages between processes, with their versions (plano-escala
 * F3-31c, the security review of the plan).
 *
 * The realtime role is deployed only when what it runs changes
 * (.github/scripts/realtime-closure.mjs), so it may run a build older than
 * the api, the worker and the ingest that talk to it. A message whose
 * shape moved under an older reader is the worst kind of silent: a
 * revocation an older realtime does not understand leaves a socket open.
 * So every message between processes carries `v`, and three rules hold:
 *
 *  - a reader accepts the version before its own (the image of before
 *    during a rolling deploy, a realtime held on its build) and any newer
 *    one: a new version only ADDS fields, so a reader takes what it knows
 *    and ignores the rest. Removing or retyping a field is a new message,
 *    under a new name;
 *  - a writer keeps every field the previous version's readers need;
 *  - any change in these payloads bumps its version below, which moves the
 *    contract epoch (`trajetto.contract-epoch`, the sum of these versions
 *    plus the contract migrations) and so deploys the realtime with the
 *    release that changes them. tests/unitaires/socket/inter-process-
 *    messages.test.ts pins each shape to its version.
 *
 * What travels between processes: the Socket.IO adapter's `serverSideEmit`
 * frames (below), the WhatsApp template lane's own channel
 * (template-lane-bus.ts) and the wake hints (wake-bus.ts). The adapter's
 * own frames (emits to rooms, `disconnectSockets` revocations) are the
 * library's protocol, pinned with @socket.io/redis-adapter and
 * @socket.io/redis-emitter in package.json: any bump of either is in the
 * realtime's source hash and deploys it.
 */

/** The version of each message; only ever grows. */
const MESSAGE_VERSIONS = {
  "adopt-session-version": 1,
  "refresh-delivery-rooms": 1,
  "whatsapp-template-lane": 1,
  "template-lane-channel": 1,
  wake: 1,
} as const;

type MessageName = keyof typeof MESSAGE_VERSIONS;

/** A version off the wire: absent is the version before `v` existed (0). */
function versionOf(value: unknown): number | null {
  if (value === undefined) return 0;

  return Number.isInteger(value) && (value as number) >= 0
    ? (value as number)
    : null;
}

/** The server-side event a kept session's new version crosses replicas on. */
const ADOPT_SESSION_VERSION_EVENT = "trajetto:adopt-session-version";

interface AdoptSessionVersion {
  sessionId: string;
  version: number;
}

function adoptSessionVersionMessage(
  sessionId: string,
  version: number,
): AdoptSessionVersion & { v: number } {
  return { v: MESSAGE_VERSIONS["adopt-session-version"], sessionId, version };
}

/** What a replica may act on, from any version; null for anything else. */
function readAdoptSessionVersion(frame: unknown): AdoptSessionVersion | null {
  if (typeof frame !== "object" || frame === null) return null;

  const { v, sessionId, version } = frame as Record<string, unknown>;

  if (versionOf(v) === null) return null;
  if (typeof sessionId !== "string" || !Number.isInteger(version)) {
    return null;
  }

  return { sessionId, version: version as number };
}

/** The server-side event each replica re-evaluates its own sockets on. */
const REFRESH_DELIVERY_ROOMS_EVENT = "trajetto:refresh-delivery-rooms";

/**
 * The arguments of the event: the company first, as the version before
 * `v` sent it (an older reader takes only that one), then `{ v }`.
 */
function refreshDeliveryRoomsArgs(businessId: string): [string, { v: number }] {
  return [businessId, { v: MESSAGE_VERSIONS["refresh-delivery-rooms"] }];
}

function readRefreshDeliveryRooms(
  businessId: unknown,
  meta?: unknown,
): string | null {
  if (typeof businessId !== "string" || businessId.length === 0) return null;

  const v =
    typeof meta === "object" && meta !== null
      ? (meta as Record<string, unknown>).v
      : undefined;

  return versionOf(v) === null ? null : businessId;
}

/** The server-side event a WhatsApp template's pause crosses replicas on. */
const WHATSAPP_TEMPLATE_LANE_EVENT = "trajetto:whatsapp-template-lane";

/**
 * The adapter's frame of a lane change: the change itself, as the version
 * before `v` sent it (its reader validates only template, action and
 * seconds), plus `v`.
 */
function templateLaneFrame<T extends object>(change: T): T & { v: number } {
  return { ...change, v: MESSAGE_VERSIONS["whatsapp-template-lane"] };
}

/** The change inside a frame of any version, or null; validated after. */
function readTemplateLaneFrame(frame: unknown): unknown {
  if (typeof frame !== "object" || frame === null) return null;

  const { v, ...change } = frame as Record<string, unknown>;

  return versionOf(v) === null ? null : change;
}

export {
  ADOPT_SESSION_VERSION_EVENT,
  MESSAGE_VERSIONS,
  REFRESH_DELIVERY_ROOMS_EVENT,
  WHATSAPP_TEMPLATE_LANE_EVENT,
  adoptSessionVersionMessage,
  readAdoptSessionVersion,
  readRefreshDeliveryRooms,
  readTemplateLaneFrame,
  refreshDeliveryRoomsArgs,
  templateLaneFrame,
  versionOf,
};
export type { AdoptSessionVersion, MessageName };
