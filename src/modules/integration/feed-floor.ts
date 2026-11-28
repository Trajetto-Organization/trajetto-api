/**
 * The floor of the integration feed (plano-escala U-16, F2-05, D66).
 *
 * The feed walks a company's events in commit order, by the writing
 * transaction's id (delivery_event.txid), and serves only what is below
 * the oldest transaction still open, so nothing can commit behind a
 * poller's cursor. Each page also starts its index scan at a floor of
 * uuid v7 ids: the created_at of the last event it served, minus
 * FEED_FLOOR_MARGIN_MS. Without it, every page of a partitioned
 * delivery_event (wave 11) would open all of its monthly partitions.
 *
 * Why the floor never skips an event. An event E the feed has not served
 * yet belongs to a transaction whose id is above the last served event's
 * transaction (T): E's transaction got its id after T got its own, and so
 * after T began. T's event was written at most WRITER_BOUND after T began,
 * because the trigger of migration 20261118100000 refuses any INSERT into
 * delivery_event (SQLSTATE TJ001) more than 240 s into its transaction. So
 * E was written less than WRITER_BOUND before the last served event, and
 * its id (the millisecond the API minted it) is above that event's
 * created_at minus WRITER_BOUND. The margin is at least twice the bound:
 * the other half absorbs the clock difference between the API processes,
 * which mint the ids, and the database, which stamps created_at.
 *
 * Pure: the numbers and the check only. The feed reads them.
 */

/**
 * How long after its transaction began an INSERT into delivery_event is
 * still accepted: the argument the triggers are created with (240 s,
 * migration 20261118100000_delivery_event_writer_bound). A unit test reads
 * the migration and keeps the two equal.
 */
const DELIVERY_EVENT_WRITER_BOUND_MS = 240_000;

/** The smallest FEED_FLOOR_MARGIN_MS the boot accepts: twice the bound. */
const FEED_FLOOR_MIN_MARGIN_MS = 2 * DELIVERY_EVENT_WRITER_BOUND_MS;

/** FEED_FLOOR_MARGIN_MS when unset: 10 min. */
const FEED_FLOOR_DEFAULT_MARGIN_MS = 600_000;

/**
 * Why a margin cannot be used, or null when it can. The env schema runs it
 * at boot: a margin under twice the bound would let the floor pass over an
 * event a long writer was still allowed to insert.
 */
function feedFloorMarginProblem(marginMs: number): string | null {
  if (!Number.isSafeInteger(marginMs) || marginMs < FEED_FLOOR_MIN_MARGIN_MS) {
    return `FEED_FLOOR_MARGIN_MS precisa ser pelo menos ${FEED_FLOOR_MIN_MARGIN_MS} (o dobro dos ${DELIVERY_EVENT_WRITER_BOUND_MS / 1000} s que um escritor de delivery_event tem desde o início da transação): com menos, o piso do feed pode passar por cima de um evento ainda gravável.`;
  }

  return null;
}

/**
 * The floor, in milliseconds, after serving an event created at
 * `lastServedCreatedAt`: never below 0 (the uuid v7 epoch), never above
 * the event itself.
 */
function feedFloorMs(lastServedCreatedAt: Date, marginMs: number): number {
  return Math.max(0, Math.floor(lastServedCreatedAt.getTime() - marginMs));
}

export {
  DELIVERY_EVENT_WRITER_BOUND_MS,
  FEED_FLOOR_DEFAULT_MARGIN_MS,
  FEED_FLOOR_MIN_MARGIN_MS,
  feedFloorMarginProblem,
  feedFloorMs,
};
