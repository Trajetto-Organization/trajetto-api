import { spreadsheetImportJob } from "@/modules/import/services/spreadsheet-import-job";

import { JobRunner } from "./job-runner";

/**
 * The handler of each durable job kind (plano-escala F3-22), registered on
 * the runner of a process that consumes the `jobs` queue. A kind without a
 * handler here is never claimed: its rows wait for the release that brings
 * one (the purge of a company, scheduled weeks ahead, waits that way).
 */
function registerJobHandlers(
  runner: JobRunner = JobRunner.getInstance(),
): void {
  // The spreadsheet upload (F3-23a).
  runner.register("SPREADSHEET_IMPORT", spreadsheetImportJob);
}

export { registerJobHandlers };
