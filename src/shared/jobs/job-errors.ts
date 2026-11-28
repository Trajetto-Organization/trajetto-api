/**
 * How a durable job ends early (plano-escala F3-22). The runner
 * (job-runner.ts) reads the class, never the message.
 */

/**
 * The job's lease is no longer this process's: it ran out (a pause, a
 * database that stopped answering) and another process claimed the job,
 * bumping `attempts`. Thrown by the fenced checkpoint inside the caller's
 * transaction, so whatever that transaction did is rolled back; the runner
 * then writes nothing — the new owner settles the job.
 */
class JobLeaseLostError extends Error {
  constructor(jobId: string) {
    super(`lease lost on background job ${jobId}`);
    this.name = "JobLeaseLostError";
  }
}

/**
 * The process is stopping (SIGTERM): the job stops at its next checkpoint
 * and is handed back to the queue without spending the attempt, to resume
 * from its cursor on whichever process claims it next.
 */
class JobStoppedError extends Error {
  constructor(jobId: string) {
    super(`background job ${jobId} stopped: the process is shutting down`);
    this.name = "JobStoppedError";
  }
}

/**
 * A failure no retry can fix (the input is gone, the subject was deleted):
 * the job fails at once instead of spending its attempts.
 */
class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentJobError";
  }
}

export { JobLeaseLostError, JobStoppedError, PermanentJobError };
