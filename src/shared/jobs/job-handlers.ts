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
  // Filled by the kinds as they arrive (the spreadsheet import, its undo,
  // the purge of a company, the anonymization of a person).
  void runner;
}

export { registerJobHandlers };
