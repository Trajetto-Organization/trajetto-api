import { Prisma } from "@prisma/client";

import database from "@/../infra/database";
import { env } from "@/env";
import { throwIfPartial } from "@/shared/errors/partial-run-error";
import { logger } from "@/shared/logging/logger";
import { CronJobDefinition } from "@/shared/services/cron-scheduler-service";

import {
  deleteInBatches,
  purgeDeadline,
  type BatchDeleteResult,
} from "./batch-delete";

/**
 * The retention of the scale plan's series (plano-escala F1-13).
 *
 * ops_sample grows by a row per process per minute (F1-08) plus the
 * cluster's (F1-10): about 1.440 rows a day each. pgss_snapshot grows by
 * the 200 statements of each hour (F1-12): 4.800 a day. Both are read for
 * at most the 30 days the plan's triggers look back on, so each night, at
 * 04:40 UTC (inside the purge window, after the 04:35 one), the rows older
 * than OPS_SAMPLE_RETENTION_DAYS / PGSS_SNAPSHOT_RETENTION_DAYS go, oldest
 * first, in batches over each table's time index.
 *
 * The small purge runs first, so the big one cannot spend its budget; both
 * run even when the first stops early, and a run that stops at the budget
 * or the ceiling with rows still due ends partial (F1-17): the catch-up
 * takes it again in the morning window.
 *
 * Nothing writes an old row: the series only ever insert the current
 * minute or hour, so the purge never races a writer.
 *
 * provider_quota_day goes too (plano-escala F2-32): a row per provider,
 * scope and UTC day, read only for today, kept PROVIDER_QUOTA_RETENTION_DAYS
 * for a look back at a month's consumption. A few rows a day (one per
 * company that searched), so one DELETE, first: nothing writes a past day.
 */
const PURGE_OPS_SERIES_JOB = "purge-ops-series";

const log = logger.child({ component: "cron", job: PURGE_OPS_SERIES_JOB });

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Rows per table per run: weeks of ops_sample for a dozen processes, far
 * more of pgss_snapshot. A first run after the series were left unpurged
 * for months takes several nights, partial, instead of one long delete.
 */
const MAX_SERIES_ROWS_PER_RUN = 1_000_000;

/** Days of provider_quota_day kept: a month's look back, and some. */
const PROVIDER_QUOTA_RETENTION_DAYS = 35;

interface OpsSeriesPurgeOptions {
  now?: Date;
  deadline?: number;
  maxRows?: number;
}

/** Purges both series; returns each table's result, partial or not. */
async function purgeOpsSeries({
  now = new Date(),
  deadline = purgeDeadline(now.getTime()),
  maxRows = MAX_SERIES_ROWS_PER_RUN,
}: OpsSeriesPurgeOptions = {}): Promise<Record<string, BatchDeleteResult>> {
  const quotaCutoff = new Date(
    now.getTime() - PROVIDER_QUOTA_RETENTION_DAYS * DAY_MS,
  )
    .toISOString()
    .slice(0, 10);

  const providerQuotaDay = await database.$executeRaw`
    DELETE FROM "provider_quota_day" WHERE "day" < ${quotaCutoff}::date
  `;

  const snapshotCutoff = new Date(
    now.getTime() - env.PGSS_SNAPSHOT_RETENTION_DAYS * DAY_MS,
  );
  const sampleCutoff = new Date(
    now.getTime() - env.OPS_SAMPLE_RETENTION_DAYS * DAY_MS,
  );

  const pgssSnapshot = await deleteInBatches({
    table: Prisma.sql`"pgss_snapshot"`,
    where: Prisma.sql`"taken_at" < ${snapshotCutoff}`,
    orderBy: Prisma.sql`"taken_at"`,
    maxRows,
    deadline,
  });

  const opsSample = await deleteInBatches({
    table: Prisma.sql`"ops_sample"`,
    where: Prisma.sql`"ts" < ${sampleCutoff}`,
    orderBy: Prisma.sql`"ts"`,
    maxRows,
    deadline,
  });

  return {
    provider_quota_day: { deleted: providerQuotaDay, stoppedEarly: false },
    pgss_snapshot: pgssSnapshot,
    ops_sample: opsSample,
  };
}

/** The run: both purges, the log line, then partial when rows are left. */
async function runOpsSeriesPurge(
  options: OpsSeriesPurgeOptions = {},
): Promise<void> {
  const results = await purgeOpsSeries(options);

  log.info(
    {
      deleted: {
        provider_quota_day: results.provider_quota_day.deleted,
        pgss_snapshot: results.pgss_snapshot.deleted,
        ops_sample: results.ops_sample.deleted,
      },
      retentionDays: {
        provider_quota_day: PROVIDER_QUOTA_RETENTION_DAYS,
        pgss_snapshot: env.PGSS_SNAPSHOT_RETENTION_DAYS,
        ops_sample: env.OPS_SAMPLE_RETENTION_DAYS,
      },
    },
    "old operation series purged",
  );

  // Rows still due: FAILED "[partial]", for the catch-up's partial window.
  throwIfPartial(results);
}

const purgeOpsSeriesJob: CronJobDefinition = {
  name: PURGE_OPS_SERIES_JOB,
  schedule: "40 4 * * *",
  handler: () => runOpsSeriesPurge(),
};

export {
  MAX_SERIES_ROWS_PER_RUN,
  PROVIDER_QUOTA_RETENTION_DAYS,
  PURGE_OPS_SERIES_JOB,
  purgeOpsSeries,
  purgeOpsSeriesJob,
  runOpsSeriesPurge,
};
