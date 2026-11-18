import { env } from "@/env";
import { workerHeartbeat } from "@/shared/health/worker-heartbeat";
import { withoutRequestContext } from "@/shared/http/request-context";
import { consumesQueue } from "@/shared/lifecycle/process-role";
import { logger } from "@/shared/logging/logger";
import { withRetryJitter } from "@/shared/notifications/pipeline-rules";
import { ContinuousPool } from "@/shared/queue/continuous-pool";
import { selfReplica } from "@/shared/wake/wake-bus";

import {
  BackgroundJobRepository,
  LEASE_RENEW_EVERY_MS,
  type BackgroundJobKind,
  type ClaimedJob,
  type IBackgroundJobRepository,
  type JobTransaction,
} from "./background-job-repository";
import {
  JobLeaseLostError,
  JobStoppedError,
  PermanentJobError,
} from "./job-errors";
import { setLocalJobWaker } from "./job-wake";

const log = logger.child({ component: "jobs" });

/**
 * The durable jobs' consumer (plano-escala F3-22), on the `jobs` queue of
 * WORKER_QUEUES: every process in the role `all` (today's production: the
 * api runs its own jobs) and the worker of a split fleet.
 *
 * A job is a row of background_job (background-job-repository.ts). The
 * runner claims it fairly by company, runs its kind's handler and settles
 * it; what makes it durable is how a run ends early:
 *
 *  - SIGKILL, OOM, a lost node: nothing is written. The lease (120 s,
 *    renewed every 40 s while the handler runs) runs out and another
 *    process claims the job, which resumes from the last checkpoint. The
 *    handler writes its effects and its cursor in one transaction, through
 *    `checkpoint(progress, tx)`, fenced on `attempts`: whatever committed
 *    is behind the cursor, whatever did not is redone, nothing twice;
 *  - SIGTERM: the handlers' AbortSignal fires, each stops at its next
 *    checkpoint (JobStoppedError, the transaction rolled back), and the job
 *    is handed back PENDING at once without spending the attempt;
 *  - the lease lost (a pause longer than the lease): the renewal or the
 *    checkpoint finds the fence moved and the run stops without writing;
 *    the process that took over settles the job;
 *  - a failure: the job is retried with backoff (30 s, 2 min, 10 min,
 *    30 min, jittered) until `maxAttempts`, then FAILED, and the kind's
 *    `onFailed` closes its domain record (the upload's report). A
 *    PermanentJobError fails at once. A job claimed past its last attempt
 *    (its process died during it) fails without running again.
 *
 * Slots: JOB_RUNNER_SLOTS jobs at once per process, one per company per
 * claim, and a kind may cap the jobs running per company across processes
 * (`maxRunningPerTenant`, the claim's predicate). Jobs are long and heavy
 * (a workbook, thousands of rows); two at a time keep one company's long
 * job from holding the queue without letting a process run a dozen.
 */
const JOB_RUNNER_SLOTS = 2;

/** Backoff between attempts; jittered by ±20%. */
const JOB_RETRY_DELAYS_MS = [
  30_000,
  2 * 60_000,
  10 * 60_000,
  30 * 60_000,
] as const;

/**
 * How long shutdown waits, at most, for the handlers to reach their next
 * checkpoint and hand their jobs back. The shutdown plan's workers deadline
 * can only shorten it. A handler past it is left to its lease.
 */
const JOB_SHUTDOWN_WAIT_MS = 10_000;

/** What a handler is given: the job, its cursor and its fence. */
interface JobContext {
  readonly id: string;
  readonly kind: BackgroundJobKind;
  readonly businessId: string | null;
  readonly subjectId: string | null;

  /** This attempt, from 1: the fence of every write. */
  readonly attempts: number;
  readonly maxAttempts: number;

  readonly payload: unknown;

  /** The cursor of the last checkpoint; null on the first attempt. */
  readonly progress: unknown;

  /** Aborts when the process stops or the lease is lost. */
  readonly signal: AbortSignal;

  /**
   * Writes the cursor (and extends the lease), fenced on this attempt;
   * with `tx`, inside the caller's transaction, so the effects it wrote
   * and the cursor commit together. Throws JobStoppedError when the run
   * must stop, and JobLeaseLostError when the job is no longer this
   * attempt's: either one, inside the transaction, rolls it back.
   */
  checkpoint(progress: unknown, tx?: JobTransaction): Promise<void>;

  /** Throws JobStoppedError (or the lease's error) when the run must stop. */
  throwIfStopped(): void;
}

/** A job that failed for good, as `onFailed` sees it. */
interface FailedJob {
  readonly id: string;
  readonly kind: BackgroundJobKind;
  readonly businessId: string | null;
  readonly subjectId: string | null;
  readonly attempts: number;
  readonly payload: unknown;
  readonly progress: unknown;
}

interface JobHandler {
  /** Runs the job to its end; resuming from `job.progress` when present. */
  run(job: JobContext): Promise<void>;

  /**
   * The job failed for good: close its domain record so the operator sees
   * why. Errors are logged; the job stays FAILED either way.
   */
  onFailed?(job: FailedJob, error: unknown): Promise<void>;

  /** Jobs of this kind running at once per company; absent = no cap. */
  maxRunningPerTenant?: () => number;
}

/** Where the job's lease stands while its handler runs. */
interface RunningJob {
  job: ClaimedJob;
  controller: AbortController;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;

  return String(error);
}

/** The delay before attempt `attempts + 1`, or null when none is left. */
function jobRetryDelayMs(attempts: number, maxAttempts: number): number | null {
  if (attempts >= maxAttempts) return null;

  const step = Math.min(Math.max(attempts, 1), JOB_RETRY_DELAYS_MS.length) - 1;

  return withRetryJitter(JOB_RETRY_DELAYS_MS[step]);
}

interface JobRunnerOptions {
  store?: IBackgroundJobRepository;
  slots?: number;
  sweepIntervalMs?: number;
  owner?: () => string;
  renewEveryMs?: number;
}

class JobRunner {
  private static instance: JobRunner | undefined;

  private readonly handlers = new Map<BackgroundJobKind, JobHandler>();

  private readonly store: IBackgroundJobRepository;
  private readonly slots: number;
  private readonly sweepIntervalMs: number;
  private readonly owner: () => string;
  private readonly renewEveryMs: number;

  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  private cycle = false;

  /** Where this process's next fair claim starts. */
  private cursor = "";

  private readonly running = new Map<string, RunningJob>();

  private readonly pool: ContinuousPool<ClaimedJob>;

  constructor(options: JobRunnerOptions = {}) {
    this.store = options.store ?? new BackgroundJobRepository();
    this.slots = options.slots ?? JOB_RUNNER_SLOTS;
    this.sweepIntervalMs =
      options.sweepIntervalMs ?? env.PIPELINE_SWEEP_INTERVAL_MS;
    this.owner = options.owner ?? selfReplica;
    this.renewEveryMs = options.renewEveryMs ?? LEASE_RENEW_EVERY_MS;

    this.pool = new ContinuousPool<ClaimedJob>({
      slots: () => this.slots,
      claim: (limit) => this.claim(limit),
      run: (job) => this.execute(job),
      giveBack: (job) => this.handBack(job),
      stopping: () => this.stopping,
      onClaim: () => workerHeartbeat.progress("background-jobs"),
    });
  }

  static getInstance(): JobRunner {
    JobRunner.instance ??= new JobRunner();

    return JobRunner.instance;
  }

  /** The handler of `kind`; a kind with none is never claimed here. */
  register(kind: BackgroundJobKind, handler: JobHandler): void {
    this.handlers.set(kind, handler);
  }

  /** The kinds this process can run. */
  kinds(): BackgroundJobKind[] {
    return [...this.handlers.keys()];
  }

  async initialize(): Promise<void> {
    this.stopping = false;

    this.timer = setInterval(() => {
      this.processBatch().catch((error) => {
        log.error({ err: error }, "background job cycle failed");
      });
    }, this.sweepIntervalMs);
    this.timer.unref?.();

    setLocalJobWaker(() => this.wake());

    // What waited while no process ran jobs: at once, not after a sweep.
    void this.processBatch().catch((error) => {
      log.error({ err: error }, "background job initial drain failed");
    });

    log.info({ kinds: this.kinds() }, "background job runner started");
  }

  /**
   * Claims now instead of at the sweep: a job was enqueued here, or
   * another process's hint says it was. One cycle at a time.
   */
  wake(): void {
    if (this.stopping || !this.timer || !consumesQueue(env, "jobs")) return;

    if (this.cycle) {
      this.pool.rescan();
      return;
    }

    withoutRequestContext(() => {
      this.processBatch().catch((error) => {
        log.error({ err: error }, "background job wake failed");
      });
    });
  }

  /**
   * SIGTERM: no claim starts, every running handler is asked to stop at
   * its next checkpoint (its job handed back without spending the
   * attempt), and the wait is bounded by `deadlineMs` — a handler past it
   * is left to its lease.
   */
  async shutdown(options: { deadlineMs?: number } = {}): Promise<void> {
    this.stopping = true;

    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    setLocalJobWaker(null);

    for (const { job, controller } of this.running.values()) {
      controller.abort(new JobStoppedError(job.id));
    }

    this.pool.nudge();

    const deadline =
      Date.now() +
      Math.min(JOB_SHUTDOWN_WAIT_MS, options.deadlineMs ?? Infinity);

    while (this.cycle && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    if (this.running.size > 0) {
      log.warn(
        { jobs: [...this.running.keys()] },
        "background jobs still running at shutdown; their leases will recover them",
      );
    }

    log.info("background job runner stopped");
  }

  /** One cycle of the pool; resolves with the jobs it claimed. */
  async processBatch(): Promise<number> {
    if (this.cycle) {
      this.pool.rescan();
      return 0;
    }

    this.cycle = true;
    workerHeartbeat.beginCycle("background-jobs");

    try {
      return await this.pool.drain();
    } finally {
      this.cycle = false;
      workerHeartbeat.endCycle("background-jobs");

      if (this.pool.rescanPending && !this.stopping) {
        setImmediate(() => this.wake());
      }
    }
  }

  private async claim(limit: number): Promise<ClaimedJob[]> {
    const kinds = this.kinds();

    if (kinds.length === 0) return [];

    const runningPerTenant: Partial<Record<BackgroundJobKind, number>> = {};

    for (const [kind, handler] of this.handlers) {
      const cap = handler.maxRunningPerTenant?.();

      if (cap !== undefined) runningPerTenant[kind] = cap;
    }

    const { jobs, cursor } = await this.store.claim({
      limit,
      owner: this.owner(),
      kinds,
      runningPerTenant,
      cursor: this.cursor,
      maxTenants: env.QUEUE_FAIR_MAX_TENANTS,
    });

    this.cursor = cursor;

    return jobs;
  }

  /** One job, start to finish; never throws. */
  private async execute(job: ClaimedJob): Promise<void> {
    const handler = this.handlers.get(job.kind);
    const where = { jobId: job.id, kind: job.kind, attempts: job.attempts };

    if (!handler) {
      // Claimed by kind, so only a handler removed under a running cycle.
      await this.handBack(job);
      return;
    }

    // Its process died during its last allowed attempt: failed without
    // running again, its record closed by the kind.
    if (job.attempts > job.maxAttempts) {
      const error = new Error(
        "a última tentativa permitida morreu com o processo",
      );

      if (await this.store.fail(job.id, job.attempts, errorText(error))) {
        await this.failed(handler, job, error);
      }

      return;
    }

    const controller = new AbortController();
    this.running.set(job.id, { job, controller });

    // A stop asked before this job started.
    if (this.stopping) controller.abort(new JobStoppedError(job.id));

    const renew = setInterval(() => {
      this.store
        .renewLease(job.id, job.attempts)
        .then((held) => {
          if (!held) controller.abort(new JobLeaseLostError(job.id));
        })
        .catch((error) => {
          // A database that does not answer: the next renewal or the
          // checkpoint decides; the lease has two renewals of room.
          log.warn({ err: error, ...where }, "lease renewal failed");
        });
    }, this.renewEveryMs);
    renew.unref?.();

    const throwIfStopped = () => {
      if (!controller.signal.aborted) return;

      const reason: unknown = controller.signal.reason;

      throw reason instanceof JobLeaseLostError
        ? reason
        : new JobStoppedError(job.id);
    };

    const context: JobContext = {
      id: job.id,
      kind: job.kind,
      businessId: job.businessId,
      subjectId: job.subjectId,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      payload: job.payload,
      progress: job.progress,
      signal: controller.signal,
      throwIfStopped,
      checkpoint: async (progress, tx) => {
        throwIfStopped();

        await this.store.checkpoint(job.id, job.attempts, progress, tx);
      },
    };

    try {
      await handler.run(context);

      if (!(await this.store.complete(job.id, job.attempts))) {
        log.warn(where, "job finished after its lease was lost");
      }
    } catch (error) {
      await this.settleFailure(handler, job, controller, error);
    } finally {
      clearInterval(renew);
      this.running.delete(job.id);
    }
  }

  private async settleFailure(
    handler: JobHandler,
    job: ClaimedJob,
    controller: AbortController,
    error: unknown,
  ): Promise<void> {
    const where = { jobId: job.id, kind: job.kind, attempts: job.attempts };
    const reason: unknown = controller.signal.reason;

    // Another process owns it now: nothing to write.
    if (
      error instanceof JobLeaseLostError ||
      reason instanceof JobLeaseLostError
    ) {
      log.warn(where, "job stopped: its lease was lost to another process");
      return;
    }

    // Stopping: back to the queue at once, the attempt not spent.
    if (
      error instanceof JobStoppedError ||
      (this.stopping && controller.signal.aborted)
    ) {
      await this.handBack(job);
      return;
    }

    const delay =
      error instanceof PermanentJobError
        ? null
        : jobRetryDelayMs(job.attempts, job.maxAttempts);

    try {
      if (delay !== null) {
        log.warn(
          { ...where, err: error, retryInMs: delay },
          "background job failed; it will be retried",
        );
        await this.store.retry(job.id, job.attempts, errorText(error), delay);

        return;
      }

      log.error({ ...where, err: error }, "background job failed for good");

      if (await this.store.fail(job.id, job.attempts, errorText(error))) {
        await this.failed(handler, job, error);
      }
    } catch (writeError) {
      // The lease recovers it: the next claim retries (or fails it past
      // its attempts).
      log.error(
        { ...where, err: writeError },
        "background job's outcome could not be written; its lease will recover it",
      );
    }
  }

  private async failed(
    handler: JobHandler,
    job: ClaimedJob,
    error: unknown,
  ): Promise<void> {
    try {
      await handler.onFailed?.(
        {
          id: job.id,
          kind: job.kind,
          businessId: job.businessId,
          subjectId: job.subjectId,
          attempts: job.attempts,
          payload: job.payload,
          progress: job.progress,
        },
        error,
      );
    } catch (closeError) {
      log.error(
        { jobId: job.id, kind: job.kind, err: closeError },
        "could not close the record of a failed job",
      );
    }
  }

  /** Back to PENDING now, fenced; a failure is left to the lease. */
  private async handBack(job: ClaimedJob): Promise<void> {
    try {
      await this.store.giveBack(job.id, job.attempts);
    } catch (error) {
      log.warn(
        { jobId: job.id, kind: job.kind, err: error },
        "background job could not be handed back; its lease will recover it",
      );
    }
  }
}

export {
  JOB_RETRY_DELAYS_MS,
  JOB_RUNNER_SLOTS,
  JOB_SHUTDOWN_WAIT_MS,
  JobRunner,
  jobRetryDelayMs,
};
export type { FailedJob, JobContext, JobHandler, JobRunnerOptions };
