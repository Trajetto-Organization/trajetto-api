import { Prisma } from "@prisma/client";

import { CronJobDefinition } from "@/shared/services/cron-scheduler-service";
import { logger } from "@/shared/logging/logger";

import { deleteInBatches, PURGE_RUN_BUDGET_MS } from "./batch-delete";

const log = logger.child({ component: "cron", job: "cleanup-api-usage" });

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long a day of API usage counts is kept: 400 days.
 *
 * The "Uso da API" screen reads at most 90 days (listApiUsageSchema), so a
 * row older than that is never shown. The table had no retention at all and
 * grows by one row per key, day, route, method and status class — about 30 a
 * day for an active key, ~40M a year if every company integrated. 400 days
 * keeps thirteen months, so "this month against the same month last year" can
 * still be answered by support, and bounds the table.
 */
const API_USAGE_RETENTION_DAYS = 400;

/** Sized for the bound above: a day's rows for every key, several times over. */
const MAX_USAGE_ROWS_PER_RUN = 1_000_000;

/**
 * The rows the purge takes. `day` is a DATE (UTC midnight of the civil day)
 * and Prisma binds a Date as timestamptz, so the cutoff is turned into a UTC
 * date explicitly instead of in the session's TimeZone. Exported so the plan
 * can be tested with the exact predicate.
 */
function apiUsageRowsBefore(cutoff: Date): Prisma.Sql {
  return Prisma.sql`"day" < (${cutoff}::timestamptz AT TIME ZONE 'UTC')::date`;
}

/**
 * Purges API usage counts past their retention, oldest day first, in batches
 * over api_key_usage_daily_day_idx (each batch stops at the cutoff instead of
 * scanning the table). Nothing else writes those old days: the recorder only
 * upserts today's bucket.
 *
 * Cron: "35 4 * * *" → daily at 04:35, after the webhook purge (04:20) and
 * before the orphan-upload sweep (04:50).
 */
const cleanupApiUsageJob: CronJobDefinition = {
  name: "cleanup-api-usage",
  schedule: "35 4 * * *",

  async handler() {
    const deadline = Date.now() + PURGE_RUN_BUDGET_MS;

    // The last 400 civil days (UTC, like `day`), today included.
    const cutoff = new Date(Date.now() - (API_USAGE_RETENTION_DAYS - 1) * DAY_MS);

    const result = await deleteInBatches({
      table: Prisma.sql`"api_key_usage_daily"`,
      where: apiUsageRowsBefore(cutoff),
      orderBy: Prisma.sql`"day"`,
      maxRows: MAX_USAGE_ROWS_PER_RUN,
      deadline,
    });

    log.info(
      { deleted: result.deleted, retentionDays: API_USAGE_RETENTION_DAYS },
      "old API usage counts purged",
    );

    if (result.stoppedEarly) {
      log.warn(
        "API usage purge stopped at the run's cap or deadline; the rest waits for the next window",
      );
    }
  },
};

export { API_USAGE_RETENTION_DAYS, apiUsageRowsBefore, cleanupApiUsageJob };
