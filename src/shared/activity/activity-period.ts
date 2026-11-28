import { env } from "@/env";
import { historyIdRange } from "@/shared/time/history-id-range";

/**
 * The period of the activity listings as ids, and the table's capped count
 * (plano-escala F2-19, decision D42).
 *
 * From the copy window of wave 11 on, activity is partitioned by month on
 * its id (a uuid v7). A period read only by created_at plans and reads
 * every month the trail has, the empty ones made ahead included; the same
 * period as a range of ids reads the one or two it is in. The range runs
 * from ACTIVITY_ID_FLOOR_MARGIN_MS (two days) before the period's first
 * instant to an hour past now (history-id-range.ts): an id is minted when
 * its row is written, but an activity of the notification pipeline carries
 * its delivery's id, minted when the event expanded, and a replica's clock
 * may be off.
 * created_at still decides what is in the period; the ids only keep the
 * read off the months that cannot hold it. Before the window, on the plain
 * table, it is a filter on rows the index found.
 *
 * The count of the table stops past ACTIVITY_COUNT_CAP (10,000): the pager
 * cannot go deeper (LIST_MAX_OFFSET), and the number past it reads
 * "10.000+" instead of a scan of the whole trail.
 */

/** The ids of a period starting at `start` and ending now; null when off. */
function activityIdRange(
  start: Date,
  now: Date = new Date(),
  marginMs: number = env.ACTIVITY_ID_FLOOR_MARGIN_MS,
): { gte: string; lt: string } | null {
  if (marginMs <= 0) return null;

  return historyIdRange(start, now, marginMs);
}

/** How many rows the count reads: one past the cap, or all with the cap off. */
function activityCountTake(
  cap: number = env.ACTIVITY_COUNT_CAP,
): number | undefined {
  return cap > 0 ? cap + 1 : undefined;
}

/** The total the table shows, and whether there were more than the cap. */
function cappedActivityTotal(
  counted: number,
  cap: number = env.ACTIVITY_COUNT_CAP,
): { total: number; totalCapped: boolean } {
  return cap > 0 && counted > cap
    ? { total: cap, totalCapped: true }
    : { total: counted, totalCapped: false };
}

export { activityCountTake, activityIdRange, cappedActivityTotal };
