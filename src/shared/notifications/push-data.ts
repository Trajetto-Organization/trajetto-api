/**
 * The `data` a push carries to the phone (wave 3, 06/11/2026).
 *
 * The tray message and the inbox row are separate deliveries of the same
 * event, so the push never knew which item it was about: the app could only
 * open the notifications screen, and a second tap opened the browser. The
 * push now carries the item (`entityId`), the company the event belongs to
 * (`businessId`, the same value the inbox row stores) and the person it was
 * sent to (`userId`): a shared phone keeps another login's notices in the
 * tray, and the app must not open them with the current session.
 *
 * Ids only, never a name or a document: this travels through Expo and FCM
 * and lands on a lock screen. Additive: builds that read only `url` keep
 * opening the notifications screen, as before.
 */
interface PushOwner {
  /** The recipient: the user this delivery was made for. */
  userId: string;
  /** The event's company; null for platform events (a MASTER's notices). */
  businessId: string | null;
}

function ownerFields(owner: PushOwner): Record<string, string> {
  return {
    userId: owner.userId,
    ...(owner.businessId ? { businessId: owner.businessId } : {}),
  };
}

/**
 * A topic whose push is its in-app render: the inbox row's coordinates. An
 * empty entity id (a render with nothing to point at) is left out rather
 * than sent as "".
 *
 * A render's `pushData` (wave 4: the authorization request's `kind` and
 * `occurrenceId`) goes first, so it adds keys and never replaces the row's
 * coordinates or the owner: an old build reads `type`/`entityId` exactly as
 * before.
 */
function inAppPushData(
  rendered: {
    link?: string | null;
    type: string;
    entityId?: string | null;
    pushData?: Record<string, string>;
  },
  owner: PushOwner,
): Record<string, unknown> {
  return {
    ...(rendered.pushData ?? {}),
    url: "/notifications",
    link: rendered.link ?? null,
    type: rendered.type,
    ...(rendered.entityId ? { entityId: rendered.entityId } : {}),
    ...ownerFields(owner),
  };
}

/**
 * A push-only render (chat, route, the tower's decision) keeps the data its
 * policy chose; the owner is added beside it and never over a key the
 * policy set.
 */
function withPushOwner(
  data: Record<string, unknown>,
  owner: PushOwner,
): Record<string, unknown> {
  return { ...ownerFields(owner), ...data };
}

export { inAppPushData, withPushOwner };
export type { PushOwner };
