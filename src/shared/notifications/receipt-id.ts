import { uuid7FromKey, uuid7InstantOf } from "./delivery-id";

/**
 * The id of a notification_provider_receipt, decided by the fact it
 * records (plano-escala F5-04).
 *
 * A provider repeats a report it did not see a 2xx for (Meta, Svix for
 * Resend), and two replicas can take the same callback. Today the unique
 * (provider, providerMessageId, status) behind `createMany({
 * skipDuplicates })` keeps that to one row; wave 10 (F5-06) drops it, since
 * the receipts become partitioned by day on their id and a unique index
 * there must contain the id. The id then keeps the promise by itself: the
 * same fact computes the same primary key.
 *
 * A uuid v7 layout, so the row lands in a day's partition:
 *
 *  - tied to a delivery: the DELIVERY's millisecond, which is its event's
 *    (delivery-id.ts). The receipt sits in the day of what it explains and
 *    is dropped with it (F5-11), however late the provider reports;
 *  - untied (a send we cannot account for, a password reset through
 *    Resend): midnight UTC of when the provider says it happened, held
 *    inside the untied receipts' retention. A report about a day older
 *    than that would go to a partition already dropped, and one from a
 *    clock ahead of ours to one not created yet. Midnight, not the
 *    millisecond: the bound moves only once a day, so the repeats of a
 *    fact that arrive hours apart still meet.
 *
 * The other 74 bits are the SHA-256 of the provider, its message id and the
 * status: the ledger's own key. An Expo ticket keeps the id it was written
 * under ('ticket') when the receipts job moves its status on.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long a receipt no delivery claims is kept (the nightly purge of
 * cleanup-notification-pipeline-job). Here because the anchor of such a
 * receipt is held inside it.
 */
const UNTIED_RECEIPT_RETENTION_DAYS = 30;

/** What a receipt says, as far as its identity goes. */
interface ReceiptFact {
  deliveryId: string | null;
  provider: string;
  providerMessageId: string;
  status: string;
  occurredAt: Date;
}

function startOfUtcDay(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/** The millisecond a receipt's id starts with. */
function receiptAnchorMs(fact: ReceiptFact, now: Date = new Date()): number {
  const delivered = fact.deliveryId ? uuid7InstantOf(fact.deliveryId) : null;

  if (delivered !== null) return delivered;

  const today = startOfUtcDay(now.getTime());
  const oldest = today - (UNTIED_RECEIPT_RETENTION_DAYS - 1) * DAY_MS;
  const reported = startOfUtcDay(fact.occurredAt.getTime());

  // An occurredAt that is not a date (NaN) is held at today, like a future one.
  if (!(reported <= today)) return today;

  return Math.max(oldest, reported);
}

/** The id of the receipt that records `fact`. */
function receiptIdFor(fact: ReceiptFact, now: Date = new Date()): string {
  // As a JSON array: the message id is the provider's text, and no
  // separator inside it can make two facts one key.
  return uuid7FromKey(
    receiptAnchorMs(fact, now),
    JSON.stringify([fact.provider, fact.providerMessageId, fact.status]),
  );
}

export { UNTIED_RECEIPT_RETENTION_DAYS, receiptAnchorMs, receiptIdFor };
export type { ReceiptFact };
