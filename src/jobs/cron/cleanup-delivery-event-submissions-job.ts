import { Prisma } from "@prisma/client";

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
 * The retention of the trail's submission keys (plano-escala F2-14).
 *
 * delivery_event_submission gets a row for every arrival, proof and "a
 * caminho" the driver app sends with a key: a few per delivery, so at the
 * 5M scale about 15 million a month. A key only matters while the app
 * could still resend it: an outbox entry goes out as soon as the phone has
 * signal, within days, and 90 days is the retention the owner decided
 * (decision D3 of the scale plan). So each night, at 04:45 UTC (inside the purge
 * window, between purge-ops-series and the orphan-upload sweep), the rows
 * older than DELIVERY_EVENT_SUBMISSION_RETENTION_DAYS (90) go, oldest
 * first, in batches over the created_at index.
 *
 * Until the copy window of wave 11 the legacy unique on
 * delivery_event.client_submission_id still holds every key, so nothing
 * the purge removes can be reused before then. A run that stops at the
 * budget or the ceiling with rows still due ends partial (F1-17), and the
 * catch-up takes it again in the morning window. Nothing writes an old
 * row: a key is written once, with its event, at the time of the request.
 */
const CLEANUP_DELIVERY_EVENT_SUBMISSIONS_JOB =
  "cleanup-delivery-event-submissions";

const log = logger.child({
  component: "cron",
  job: CLEANUP_DELIVERY_EVENT_SUBMISSIONS_JOB,
});

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Rows per run: weeks of keys at the 5M scale. A first run after months
 * without a purge takes several nights, partial, instead of one long one.
 */
const MAX_SUBMISSION_ROWS_PER_RUN = 1_000_000;

interface SubmissionPurgeOptions {
  now?: Date;
  deadline?: number;
  maxRows?: number;
}

/** The purge itself; the result says whether rows were left. */
function purgeDeliveryEventSubmissions({
  now = new Date(),
  deadline = purgeDeadline(now.getTime()),
  maxRows = MAX_SUBMISSION_ROWS_PER_RUN,
}: SubmissionPurgeOptions = {}): Promise<BatchDeleteResult> {
  const cutoff = new Date(
    now.getTime() - env.DELIVERY_EVENT_SUBMISSION_RETENTION_DAYS * DAY_MS,
  );

  return deleteInBatches({
    table: Prisma.sql`"delivery_event_submission"`,
    where: Prisma.sql`"created_at" < ${cutoff}`,
    orderBy: Prisma.sql`"created_at"`,
    key: Prisma.sql`"client_submission_id"`,
    maxRows,
    deadline,
  });
}

/** The run: the purge, the log line, then partial when rows are left. */
async function runDeliveryEventSubmissionsPurge(
  options: SubmissionPurgeOptions = {},
): Promise<void> {
  const result = await purgeDeliveryEventSubmissions(options);

  log.info(
    {
      deleted: result.deleted,
      retentionDays: env.DELIVERY_EVENT_SUBMISSION_RETENTION_DAYS,
    },
    "old delivery event submission keys purged",
  );

  // Rows still due: FAILED "[partial]", for the catch-up's partial window.
  throwIfPartial({ delivery_event_submission: result });
}

const cleanupDeliveryEventSubmissionsJob: CronJobDefinition = {
  name: CLEANUP_DELIVERY_EVENT_SUBMISSIONS_JOB,
  schedule: "45 4 * * *",
  handler: () => runDeliveryEventSubmissionsPurge(),
};

export {
  CLEANUP_DELIVERY_EVENT_SUBMISSIONS_JOB,
  MAX_SUBMISSION_ROWS_PER_RUN,
  cleanupDeliveryEventSubmissionsJob,
  purgeDeliveryEventSubmissions,
  runDeliveryEventSubmissionsPurge,
};
