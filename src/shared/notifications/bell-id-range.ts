import { uuid7Floor } from "@/shared/time/uuid7-floor";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The ids the bell's reads look at (plano-escala F5-15): from the first
 * day of the month that holds the oldest notification the retention keeps
 * (NOTIFICATION_UNREAD_RETENTION_DAYS back; a read one leaves sooner) to a
 * day ahead of now.
 *
 * Once the bell is partitioned by month on its id, a read that names no id
 * plans and reads every month attached; the range keeps the list, the
 * counts and the "mark all as read" on the months the retention keeps (at
 * most seven with 180 days) and off the months made ahead. It changes no
 * answer: every row past the retention is the nightly purge's already,
 * and a notification's id is its delivery's (the event's millisecond,
 * F5-14), never ahead of now but for a replica's clock, which the day of
 * margin covers. Before the swap, on the plain table, the same range is a
 * filter on rows the user index already found.
 */
function bellIdRange(
  retentionDays: number,
  now: Date = new Date(),
): { gte: string; lt: string } {
  const oldest = new Date(now.getTime() - retentionDays * DAY_MS);
  const monthStart = Date.UTC(oldest.getUTCFullYear(), oldest.getUTCMonth(), 1);

  return {
    gte: uuid7Floor(monthStart),
    lt: uuid7Floor(now.getTime() + DAY_MS),
  };
}

export { bellIdRange };
