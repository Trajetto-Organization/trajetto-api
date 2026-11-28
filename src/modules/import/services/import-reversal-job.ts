import { container } from "tsyringe";

import type { JobHandler } from "@/shared/jobs/job-runner";

import { ReverseImportUseCase } from "../usecases/reverse-import/reverse-import-usecase";

/**
 * The IMPORT_REVERSAL job (plano-escala F3-24): an undo past
 * REVERSAL_INLINE_LIMIT deliveries, enqueued by the api with
 * IMPORT_DURABLE_JOBS and run by whichever process consumes the `jobs`
 * queue, its 60 s batches off the HTTP process. The use case does the work
 * (runJob). A failure for good leaves the record COMPLETED with what the
 * committed batches removed (the screen reads it INTERRUPTED), and asking
 * again resumes it: nothing to close.
 *
 * Registered on every process that runs jobs whatever the flag says, like
 * the spreadsheet import: a job already enqueued always runs to its end.
 */
const importReversalJob: JobHandler = {
  run: (job) => container.resolve(ReverseImportUseCase).runJob(job),
};

export { importReversalJob };
