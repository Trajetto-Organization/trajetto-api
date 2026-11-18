import { uuid7Floor, uuid7Instant } from "@/shared/time/uuid7-floor";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How far an id of the history may sit from the instant a read is about
 * (plano-escala F2-17): two days either way.
 *
 * delivery_event is partitioned by month on its id, a uuid v7 minted by the
 * app when the row is written, and created_at is the database's clock at
 * that same insert. A read that names only created_at, or only a delivery,
 * plans and reads every month attached; one that also bounds the id reads
 * the one or two months the answer is in. The margin covers what separates
 * the id's millisecond from the instant the read starts from: a replica's
 * clock, a delivery created on one replica and its first event written on
 * another. It changes no answer: every row the read wants is inside it.
 */
const HISTORY_ID_MARGIN_MS = 2 * DAY_MS;

/** The version nibble of a uuid v7: `xxxxxxxx-xxxx-7xxx-…`. */
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * The ids of the rows written from `from` to `to`: from the smallest id of
 * `from` minus the margin to the smallest of `to` plus it. `to` defaults to
 * now (nothing is minted ahead of the clock but by the margin).
 */
function historyIdRange(
  from: Date,
  to: Date = new Date(),
  marginMs: number = HISTORY_ID_MARGIN_MS,
): { gte: string; lt: string } {
  return {
    gte: uuid7Floor(from.getTime() - marginMs),
    lt: uuid7Floor(to.getTime() + marginMs),
  };
}

/**
 * The ids of what happened to an entity from its creation to now, from the
 * entity's own id when it is a uuid v7 (a delivery's: its events are
 * written after it, never before). Null for any other id (a v4 of a
 * fixture, an id of another shape): no bound, the read stays as it was.
 */
function historyIdRangeSince(
  id: string,
  now: Date = new Date(),
  marginMs: number = HISTORY_ID_MARGIN_MS,
): { gte: string; lt: string } | null {
  if (!UUID_V7.test(id)) return null;

  const instant = uuid7Instant(id);

  return instant === null
    ? null
    : historyIdRange(new Date(instant), now, marginMs);
}

export { HISTORY_ID_MARGIN_MS, historyIdRange, historyIdRangeSince };
