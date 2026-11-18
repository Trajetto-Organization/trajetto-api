import { container } from "tsyringe";

import { env } from "@/env";
import type { JobHandler } from "@/shared/jobs/job-runner";

import { ImportDeliverySpreadsheetUseCase } from "../usecases/import-delivery-spreadsheet/import-delivery-spreadsheet-usecase";

/**
 * The SPREADSHEET_IMPORT job (plano-escala F3-23a): an upload enqueued by
 * the api with IMPORT_DURABLE_JOBS, run by whichever process consumes the
 * `jobs` queue. The use case does the work (runJob); here are the rules of
 * the kind:
 *
 *  - IMPORT_RUNNING_PER_TENANT imports of one company run at once, across
 *    every process (the claim's cap); the others wait their turn;
 *  - a failure for good closes the record with what was created, the
 *    stored file kept seven days.
 *
 * Registered on every process that runs jobs whatever IMPORT_DURABLE_JOBS
 * says there: the flag decides how an upload is ACCEPTED, and a job already
 * enqueued (by an api with the flag on, or before the flag was turned off)
 * still runs to its end.
 */
const spreadsheetImportJob: JobHandler = {
  maxRunningPerTenant: () => env.IMPORT_RUNNING_PER_TENANT,

  run: (job) => container.resolve(ImportDeliverySpreadsheetUseCase).runJob(job),

  onFailed: (job) =>
    container.resolve(ImportDeliverySpreadsheetUseCase).closeFailedJob(job),
};

export { spreadsheetImportJob };
