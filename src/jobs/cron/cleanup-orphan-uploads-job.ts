import { env } from "@/env";

import { logger } from "@/shared/logging/logger";
import { CronJobDefinition } from "@/shared/services/cron-scheduler-service";
import { runOrphanUploadGc } from "@/shared/services/orphan-uploads";

const log = logger.child({ component: "cron", job: "cleanup-orphan-uploads" });

/**
 * Counts — and, when switched on, removes — stored objects that never became
 * a row: photos uploaded for a form that was never sent, objects the head
 * check refused, cleanup deletes that failed. Nothing collected them before,
 * so the bucket only grew.
 *
 * Mode from UPLOAD_ORPHAN_GC: `dry-run` by default, which only logs the
 * summary below; `delete` after those numbers have been reviewed. The rules
 * that keep it from touching a live object (age window, key format, reference
 * lookups) live in orphan-uploads.ts.
 *
 * Cron: "50 4 * * *" → daily at 04:50, after the other cleanups.
 */
const cleanupOrphanUploadsJob: CronJobDefinition = {
  name: "cleanup-orphan-uploads",
  schedule: "50 4 * * *",

  async handler() {
    const summary = await runOrphanUploadGc({ mode: env.UPLOAD_ORPHAN_GC });

    if (!summary) return;

    log.info({ summary }, "orphan upload sweep finished");

    if (summary.failed > 0) {
      // Each failure was logged with its key by tryDeleteFile; this is the
      // count, for the alert to key on.
      log.warn({ failed: summary.failed }, "orphan uploads could not be deleted");
    }

    if (summary.errors > 0) {
      // Not one scope answered: storage credentials without List, or the
      // database down. That is the job failing, and the scheduler should
      // record it as such rather than a quiet night.
      if (summary.scopes === 0) {
        throw new Error(
          `[CleanupOrphanUploads] Nenhum escopo pôde ser lido (${summary.errors} erro(s))`,
        );
      }

      // The first few were logged with their scope by the collector.
      log.warn(
        { skippedScopes: summary.errors },
        "scopes skipped after an error; left for the next windows",
      );
    }

    if (summary.stoppedEarly) {
      // Each object has three nights in its window, so the rest waits.
      log.warn(
        "orphan upload sweep stopped by its time budget; the rest is left for the next windows",
      );
    }
  },
};

export { cleanupOrphanUploadsJob };
