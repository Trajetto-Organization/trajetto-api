import { Prisma } from "@prisma/client";

import { databaseBatch } from "@/../infra/database";
import { logger } from "@/shared/logging/logger";
import { UploadService } from "@/shared/services/upload-service";

const log = logger.child({ component: "import" });

/**
 * The stored files of the durable imports (plano-escala F3-23a), released
 * by the nightly cleanup-background-jobs:
 *
 *  - a job that ended well deletes its file itself; this deletes it again an
 *    hour on (a delete of a missing key is a success) and marks it, so a
 *    delete that failed at the end of the job is retried;
 *  - a job that failed for good, or was cancelled, keeps its file seven
 *    days, for whoever looks into what went wrong, and then loses it.
 *
 * A job with its file not released yet is never purged
 * (`importObjectsKept`): the file would stay in the bucket with nothing
 * pointing at it.
 */
const FAILED_IMPORT_FILE_KEPT_DAYS = 7;
const SUCCEEDED_IMPORT_FILE_GRACE_MS = 60 * 60 * 1000;
const RELEASES_PER_RUN = 500;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The jobs the purge must keep: their stored file is still there. */
const importObjectsKept = Prisma.sql`("kind" = 'SPREADSHEET_IMPORT' AND "payload"->>'objectKey' IS NOT NULL AND "payload"->>'objectReleasedAt' IS NULL)`;

async function releaseImportObjects({
  now = Date.now(),
  uploads = new UploadService(),
  limit = RELEASES_PER_RUN,
}: {
  now?: number;
  uploads?: Pick<UploadService, "tryDeleteFile">;
  limit?: number;
} = {}): Promise<{ released: number; failed: number }> {
  const succeededBefore = new Date(now - SUCCEEDED_IMPORT_FILE_GRACE_MS);
  const failedBefore = new Date(now - FAILED_IMPORT_FILE_KEPT_DAYS * DAY_MS);

  const due = await databaseBatch.$queryRaw<Array<{ id: string; key: string }>>`
    SELECT "id", "payload"->>'objectKey' AS "key"
    FROM "background_job"
    WHERE ${importObjectsKept}
      AND (
        ("status" = 'SUCCEEDED' AND "finished_at" < ${succeededBefore})
        OR ("status" IN ('FAILED', 'CANCELLED') AND "finished_at" < ${failedBefore})
      )
    ORDER BY "finished_at"
    LIMIT ${limit}::int
  `;

  let released = 0;
  let failed = 0;

  for (const { id, key } of due) {
    // Logged with its key by the service when it fails; tried again on
    // the next night.
    if (!(await uploads.tryDeleteFile(key))) {
      failed += 1;
      continue;
    }

    await databaseBatch.$executeRaw`
      UPDATE "background_job"
      SET "payload" = "payload" || jsonb_build_object('objectReleasedAt', now())
      WHERE "id" = ${id}
    `;

    released += 1;
  }

  if (released > 0 || failed > 0) {
    log.info({ released, failed }, "stored import files released");
  }

  return { released, failed };
}

export {
  FAILED_IMPORT_FILE_KEPT_DAYS,
  SUCCEEDED_IMPORT_FILE_GRACE_MS,
  importObjectsKept,
  releaseImportObjects,
};
