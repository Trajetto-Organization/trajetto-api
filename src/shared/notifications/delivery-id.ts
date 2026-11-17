import { createHash } from "node:crypto";

import type { NotificationChannel } from "@prisma/client";

import { uuid7Instant } from "@/shared/time/uuid7-floor";

/**
 * The id of a notification_delivery, decided by what the row IS
 * (plano-escala F5-03): the same event, recipient and channel always get
 * the same id, on every expansion of the event.
 *
 * What makes a re-expansion a no-op today is the pair of partial unique
 * indexes on (outboxEventId, userId | externalRecipientId, channel), behind
 * `createMany({ skipDuplicates })`: a worker that lost the event's lease to
 * another replica, or a retry after a crash, inserts nothing new. Wave 10
 * (F5-06) drops them, because the queues become partitioned by day on
 * their id and a unique index there must contain the id. The id then
 * carries the promise by itself: a second expansion computes the same
 * primary keys, and `skipDuplicates` (ON CONFLICT DO NOTHING) skips them.
 *
 * The layout is a uuid v7, so the id still sorts in time order and lands in
 * the right daily partition:
 *
 *  - 48 bits: the EVENT's millisecond — the one its own uuid v7 id starts
 *    with (or its created_at, for an id that is not a v7). Every delivery
 *    of an event shares the event's day, so the family of a day (events,
 *    deliveries, their receipts and keys) is dropped together (F5-11);
 *  - version 7 and the RFC 9562 variant, in their usual places;
 *  - the other 74 bits: SHA-256 of the event id, the kind and id of the
 *    recipient and the channel. Two rows only meet under the same
 *    millisecond, and 74 bits keep any two of them apart for good.
 *
 * Not a secret and not random: anybody who knows the event, the recipient
 * and the channel can compute the id. It is never an access token — every
 * route that takes one is MASTER-only and reads the row by it.
 */

/** The slice of an outbox event the id is built from. */
interface DeliveryIdEvent {
  id: string;
  created_at: Date | string;
}

/** Exactly one of the two is set, as on the row (its CHECK says so). */
interface DeliveryIdRecipient {
  userId?: string | null;
  externalRecipientId?: string | null;
}

/** A uuid v7 id: the version nibble is the 13th hex digit. */
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The event's millisecond: the one its uuid v7 id was minted at, which is
 * also the bound of the event's own daily partition. An id of another
 * version starts with random bits, not a time, so its created_at stands in.
 */
function eventInstantMs(event: DeliveryIdEvent): number {
  return uuid7InstantOf(event.id) ?? new Date(event.created_at).getTime();
}

function recipientKey(recipient: DeliveryIdRecipient): string {
  if (recipient.userId && !recipient.externalRecipientId) {
    return `user:${recipient.userId}`;
  }

  if (recipient.externalRecipientId && !recipient.userId) {
    return `external:${recipient.externalRecipientId}`;
  }

  throw new Error(
    "A notification delivery addresses exactly one recipient: a user or an external recipient",
  );
}

/**
 * A uuid v7 that starts with `ms` and carries, in its other 74 bits, the
 * SHA-256 of `key`: the same key under the same millisecond is always the
 * same id. Shared by every queue row whose id is decided by what it is.
 */
function uuid7FromKey(ms: number, key: string): string {
  const digest = createHash("sha256").update(key).digest();

  const bytes = Buffer.alloc(16);

  bytes.writeUIntBE(Math.max(0, Math.floor(ms)), 0, 6);
  bytes[6] = 0x70 | (digest[0] & 0x0f);
  bytes[7] = digest[1];
  bytes[8] = 0x80 | (digest[2] & 0x3f);
  digest.copy(bytes, 9, 3, 10);

  const hex = bytes.toString("hex");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The millisecond a uuid v7 starts with; null for any other text. */
function uuid7InstantOf(id: string): number | null {
  return UUID_V7.test(id) ? uuid7Instant(id) : null;
}

/** The id of the delivery of `event` to `recipient` on `channel`. */
function deliveryIdFor(
  event: DeliveryIdEvent,
  recipient: DeliveryIdRecipient,
  channel: NotificationChannel,
): string {
  // Ids, the recipient's kind and an enum name: none of them holds a "|".
  return uuid7FromKey(
    eventInstantMs(event),
    `${event.id}|${recipientKey(recipient)}|${channel}`,
  );
}

export { deliveryIdFor, eventInstantMs, uuid7FromKey, uuid7InstantOf };
export type { DeliveryIdEvent, DeliveryIdRecipient };
