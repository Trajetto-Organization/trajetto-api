import { Prisma } from "@prisma/client";

import { CronJobDefinition } from "@/shared/services/cron-scheduler-service";
import { logger } from "@/shared/logging/logger";

import { deleteInBatches, PURGE_RUN_BUDGET_MS } from "./batch-delete";

const log = logger.child({ component: "cron", job: "cleanup-user-history" });

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Read bell notifications: 90 days.
 *
 * A read notification is a receipt, not a record. The thing it points at —
 * the fine, the service order, the account payable — lives in its own table
 * with its own retention, and the audit narrative lives in `activity`. The
 * bell feed is paginated newest-first (see
 * NotificationRepository.listUserNotificationsWithCursor) and nobody scrolls
 * a quarter of a year back through it. Matching the outbox's 30-day
 * retention would have been defensible too; 90 days is the conservative
 * side of that call.
 */
const READ_NOTIFICATION_RETENTION_DAYS = 90;

/**
 * Unread bell notifications: 180 days, double the read window.
 *
 * An unread notification is still an open loop for the user, and it is the
 * only place that signal exists — deleting it silently drops the unread
 * badge that was the whole point. Six months is well past "they are never
 * going to read it" while never being the reason someone misses something.
 */
const UNREAD_NOTIFICATION_RETENTION_DAYS = 180;

/**
 * Same sizing logic as the outbox purge: notifications are created roughly
 * one per IN_APP delivery, so the nightly ceiling has to clear more than a
 * day's inflow or the table grows without bound.
 */
const MAX_NOTIFICATIONS_PER_RUN = 1_000_000;

/**
 * `activity` is the audit trail, and audit trails are not disk-usage
 * problems — they are compliance artifacts. Deleting a fleet's history by
 * mistake is unrecoverable and cannot be explained to a customer, while
 * keeping it costs a few gigabytes. So the trail is NEVER purged by default:
 * this half of the job is dark unless an operator sets
 * ACTIVITY_RETENTION_DAYS, and even then anything under a year is refused,
 * because a retention shorter than the longest audit cycle the product is
 * plausibly asked about is almost certainly a typo rather than a decision.
 *
 * Read straight from process.env instead of the zod env schema on purpose:
 * this is an opt-in operational lever, and a missing or malformed value must
 * degrade to "do not delete anything", never to a boot failure.
 */
const ACTIVITY_RETENTION_ENV = "ACTIVITY_RETENTION_DAYS";
const ACTIVITY_MIN_RETENTION_DAYS = 365;

/** Activity rows are one per meaningful write; same order as notifications. */
const MAX_ACTIVITIES_PER_RUN = 1_000_000;

interface NotificationPurgePass {
  where: Prisma.Sql;
  orderBy: Prisma.Sql;
}

/**
 * The bell notifications past their retention — read ones before
 * `readBefore`, unread ones before `unreadBefore` — as two walks of
 * notification_created_at_idx, each bounded by the index and neither reading
 * a row it keeps on the way to a full batch.
 *
 * It used to be one predicate, `(read AND < readBefore) OR (NOT read AND <
 * unreadBefore)`, walked oldest first. An OR with two different bounds is not
 * an index bound, so every batch that did not fill (the last of every run)
 * read to the newest notification of the table. And between the two cutoffs
 * the unread rows are KEPT — much of that band, since plenty of users never
 * open the bell — while the rows an ordinary night deletes are the read ones
 * that just crossed the shorter cutoff, at the band's NEW end. Walked oldest
 * first, every batch waded through the whole kept band again to reach them:
 * a night cost the band times the number of batches.
 *
 *   1. Older than both cutoffs: everything goes, read or not. A plain range,
 *      oldest first, where every row the walk meets is deleted.
 *   2. Between the cutoffs: only the state with the shorter retention goes.
 *      Walked NEWEST first, it meets the rows that just expired at once;
 *      only the run's final, short batch crosses the kept band, once.
 */
function notificationPurgePasses(
  readBefore: Date,
  unreadBefore: Date,
): NotificationPurgePass[] {
  // Read rows expire first with today's windows (90 against 180 days); the
  // passes do not depend on it.
  const readExpiresFirst = readBefore.getTime() >= unreadBefore.getTime();
  const older = readExpiresFirst ? unreadBefore : readBefore;
  const newer = readExpiresFirst ? readBefore : unreadBefore;

  return [
    {
      where: Prisma.sql`"created_at" < ${older}`,
      orderBy: Prisma.sql`"created_at"`,
    },
    {
      where: Prisma.sql`"read" = ${readExpiresFirst} AND "created_at" >= ${older} AND "created_at" < ${newer}`,
      orderBy: Prisma.sql`"created_at" DESC`,
    },
  ];
}

/**
 * Returns the configured activity retention, or null when the purge should
 * stay off — which is the default and the safe answer for anything the
 * operator did not spell out correctly.
 */
function resolveActivityRetentionDays(): number | null {
  const raw = process.env[ACTIVITY_RETENTION_ENV]?.trim();

  if (!raw) {
    return null;
  }

  const days = Number(raw);

  if (!Number.isInteger(days) || days < ACTIVITY_MIN_RETENTION_DAYS) {
    log.warn(
      {
        variable: ACTIVITY_RETENTION_ENV,
        value: raw,
        minimumDays: ACTIVITY_MIN_RETENTION_DAYS,
      },
      "activity retention ignored: it must be an integer of at least the minimum; the audit trail is kept whole",
    );

    return null;
  }

  return days;
}

/**
 * Retention for the two user-facing history tables, which until now grew
 * without any bound at all.
 *
 * `notification` is pruned by age with a longer grace for unread rows.
 * `activity` is only pruned when explicitly opted into — see the constants
 * above for why the two are treated so differently.
 *
 * Both deletes walk ("created_at") within index bounds (the notification
 * band newest first, see notificationPurgePasses) and run in bounded
 * batches, so the purge never becomes a long transaction pinning the xmin
 * horizon. Neither table is claimed by a worker, so there is nothing to race.
 *
 * Cron: "0 4 * * *" → daily at 04:00, after the two pipeline purges.
 */
const cleanupUserHistoryJob: CronJobDefinition = {
  name: "cleanup-user-history",
  schedule: "0 4 * * *",

  async handler() {
    const deadline = Date.now() + PURGE_RUN_BUDGET_MS;

    const readBefore = new Date(
      Date.now() - READ_NOTIFICATION_RETENTION_DAYS * DAY_MS,
    );

    const unreadBefore = new Date(
      Date.now() - UNREAD_NOTIFICATION_RETENTION_DAYS * DAY_MS,
    );

    // Two passes sharing the run's ceiling and deadline (see
    // notificationPurgePasses). Deleting a notification can never resurrect
    // a duplicate through the `deliveryId` unique constraint: the delivery
    // that created it is terminal within minutes and its row is
    // cascade-deleted with the outbox event at 30 days, long before the
    // shortest window here.
    const notifications = { deleted: 0, stoppedEarly: false };

    for (const pass of notificationPurgePasses(readBefore, unreadBefore)) {
      const result = await deleteInBatches({
        table: Prisma.sql`"notification"`,
        where: pass.where,
        orderBy: pass.orderBy,
        maxRows: MAX_NOTIFICATIONS_PER_RUN - notifications.deleted,
        deadline,
      });

      notifications.deleted += result.deleted;

      if (result.stoppedEarly) {
        notifications.stoppedEarly = true;
        break;
      }
    }

    log.info({ deleted: notifications.deleted }, "old notifications purged");

    if (notifications.stoppedEarly) {
      log.warn(
        "notification purge stopped at the run's cap or deadline; the rest waits for the next window",
      );
    }

    const activityRetentionDays = resolveActivityRetentionDays();

    if (activityRetentionDays === null) {
      return;
    }

    const activitiesBefore = new Date(
      Date.now() - activityRetentionDays * DAY_MS,
    );

    const activities = await deleteInBatches({
      table: Prisma.sql`"activity"`,
      where: Prisma.sql`"created_at" < ${activitiesBefore}`,
      orderBy: Prisma.sql`"created_at"`,
      maxRows: MAX_ACTIVITIES_PER_RUN,
      deadline,
    });

    log.info(
      { deleted: activities.deleted, retentionDays: activityRetentionDays },
      "opt-in activity trail purge done",
    );
  },
};

export { cleanupUserHistoryJob, notificationPurgePasses };
