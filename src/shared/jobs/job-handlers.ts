import { importReversalJob } from "@/modules/import/services/import-reversal-job";
import { spreadsheetImportJob } from "@/modules/import/services/spreadsheet-import-job";

import { JobRunner } from "./job-runner";
import { tenantOffboardJob } from "./tenant-offboard/tenant-offboard-job";
import { userAnonymizeJob } from "./user-anonymize/user-anonymize-job";

/**
 * The handler of each durable job kind (plano-escala F3-22), registered on
 * the runner of a process that consumes the `jobs` queue. A kind without a
 * handler here is never claimed: its rows wait for the release that brings
 * one.
 */
function registerJobHandlers(
  runner: JobRunner = JobRunner.getInstance(),
): void {
  // The spreadsheet upload (F3-23a) and its large undo (F3-24).
  runner.register("SPREADSHEET_IMPORT", spreadsheetImportJob);
  runner.register("IMPORT_REVERSAL", importReversalJob);

  // A company's purge (F3-26a): claimed only on the day its schedule set,
  // and nothing is deleted unless the company is still SCHEDULED then.
  runner.register("TENANT_OFFBOARD", tenantOffboardJob);

  // A driver or a login who worked, removed and anonymized (F3-27).
  runner.register("USER_ANONYMIZE", userAnonymizeJob);
}

export { registerJobHandlers };
