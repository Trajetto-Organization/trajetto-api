import { CronJobDefinition } from "@/shared/services/cron-scheduler-service";
import { logger } from "@/shared/logging/logger";

import { ImportRepository } from "@/modules/import/repositories/import-repository";

const log = logger.child({ component: "cron", job: "close-abandoned-imports" });

/**
 * How long without a heartbeat before a running upload is considered dead.
 *
 * A live upload touches its record every 25 rows and before every route group
 * (ImportDeliverySpreadsheetUseCase), so fifteen minutes of silence is not a
 * slow sheet: it is a process that is gone.
 */
const STALE_AFTER_MS = 15 * 60 * 1000;

/**
 * Closes the uploads whose process died halfway (IDEMP-10).
 *
 * An upload opens IN_PROGRESS before its first row, so everything it creates
 * carries its id — the point being that an interrupted upload can still be
 * undone. A failure the process survives closes it on the spot; an OOM, a
 * SIGKILL or a lost node closes nothing, and the undo refuses a running
 * upload. This closes those as COMPLETED, counting the deliveries they did
 * create and saying in the report that the file was not finished, which is
 * what the undo — and the panel's "Estornar" button — accept.
 *
 * Idempotent and bounded: the write re-checks the status and the staleness,
 * so an upload whose heartbeat came back is left alone, and a run closes at
 * most a hundred.
 *
 * Cron: every 5 minutes, on one replica (the scheduler's election).
 */
const closeAbandonedImportsJob: CronJobDefinition = {
  name: "close-abandoned-imports",
  schedule: "*/5 * * * *",

  async handler() {
    const closed = await new ImportRepository().closeAbandonedImports(
      new Date(Date.now() - STALE_AFTER_MS),
    );

    if (closed > 0) {
      log.warn(
        { closed },
        "uploads left running by a dead process were closed; they can now be reversed",
      );
    }
  },
};

export { closeAbandonedImportsJob };
