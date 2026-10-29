import { ServiceBusyError } from "@/shared/errors/service-busy-error";
import { logger } from "@/shared/logging/logger";

const log = logger.child({ component: "import" });

/**
 * The spreadsheet uploads this replica processes after answering them.
 *
 * A 20k-row sheet took over 100 s inside the request — one transaction per
 * row — and the edge (Cloudflare) gives up at 100 s: the operator saw a 524
 * and an error toast while the API kept creating the deliveries behind it.
 * The request now validates, opens the import record and answers 202; the
 * rows are processed here, on the same replica, and the client follows the
 * record (GET /import/get-import), which already says IN_PROGRESS until the
 * report is written.
 *
 * One at a time per replica: an upload is a load of the workbook (hundreds
 * of megabytes and seconds of CPU for a big one) and a long run of writes,
 * and two in parallel only doubled the memory peak and the pool pressure for
 * everyone else on the replica. A few may wait; past that the upload is
 * refused (429 IMPORT_BUSY, with Retry-After) before anything is written.
 *
 * Nothing here survives the process, and the queue says so on the way out
 * (`drain`, from the shutdown sequence). A deploy used to drop the running
 * upload mid-file and up to three waiting ones that had already been
 * answered 202; each stayed IN_PROGRESS until the close-abandoned-imports
 * sweep found its heartbeat stale, 15 to 20 minutes later. Now, on SIGTERM:
 *
 *  - new uploads are refused (429 IMPORT_BUSY, Retry-After), so the client
 *    sends them again to a replica that will still be there;
 *  - the waiting ones are handed back at once (`abandon("waiting")`): their
 *    record closes saying nothing was created and the file must be sent
 *    again;
 *  - the running one keeps going for the grace period, then is asked to stop
 *    at its next row (the AbortSignal `run` receives) and closes its own
 *    record with what it did; one that does not stop in time is handed back
 *    too (`abandon("running")`).
 *
 * A process that dies without SIGTERM (OOM, SIGKILL, a lost node) still
 * leaves IN_PROGRESS behind, and the sweep remains the floor under that — it
 * writes the same kind of report, counted from the rows themselves
 * (IDEMP-10). Waiting uploads are kept alive with the same heartbeat, so the
 * sweep never closes one that is only in line.
 */
const IMPORTS_RUNNING_PER_REPLICA = 1;
const IMPORTS_WAITING_PER_REPLICA = 3;

/** Well inside the sweep's 15 minutes: a waiting upload is not abandoned. */
const WAITING_HEARTBEAT_MS = 2 * 60 * 1000;

/** What the refusal tells the client to wait. */
const IMPORT_RETRY_AFTER_SECONDS = 30;

/**
 * After the running upload was asked to stop, how long it has to reach a row
 * boundary and close its record before the queue hands it back itself. A row
 * is one short transaction; this only runs out on a job stuck in a single
 * call (a huge workbook still being parsed, a database that stopped
 * answering).
 */
const IMPORT_STOP_GRACE_MS = 5_000;

/**
 * How long the drain then waits for the hand-back writes still in flight. A
 * healthy database takes milliseconds; one that stopped answering would hold
 * them up to the pool timeout, and the workers still need their own deadline
 * (12 s at most, the webhook dispatcher's) inside the 35 s shutdown
 * watchdog: 15 s of grace (server.ts), 5 s to stop and 2 s here end the
 * import step by 22 s. A write that misses it is left to the
 * abandoned-import sweep.
 */
const IMPORT_HANDBACK_WRITE_MS = 2_000;

/** Where in the queue a handed-back job was. */
type AbandonedStage = "waiting" | "running";

interface ImportJob {
  importId: string;

  /**
   * Processes the upload. Expected to close its own record, never to throw.
   * `signal` aborts when the replica is shutting down: stop at the next safe
   * point and close the record with what was done.
   */
  run: (signal: AbortSignal) => Promise<unknown>;

  /** Keeps the record's heartbeat while the job waits for its turn. */
  heartbeat: () => Promise<void>;

  /**
   * The replica is going away and this job will not finish here: close or
   * release its record now, so the client sees it at once instead of after
   * the sweep. "waiting": it never started. "running": it was asked to stop
   * and did not in time. Errors are logged by the queue.
   */
  abandon: (stage: AbandonedStage) => Promise<void>;
}

interface ImportTicket {
  /** Queues the job the reservation was taken for. */
  submit: (job: ImportJob) => void;

  /** Gives the place back (the upload was refused after all). */
  cancel: () => void;
}

interface ImportDrainOptions {
  /** How long the running upload may keep going before it is asked to stop. */
  graceMs: number;

  /** How long it then has to stop on its own (IMPORT_STOP_GRACE_MS). */
  stopGraceMs?: number;

  /** How long the hand-back writes may take after that (IMPORT_HANDBACK_WRITE_MS). */
  handBackMs?: number;
}

class ImportQueue {
  private reserved = 0;

  private readonly active = new Set<ImportJob>();

  private readonly waiting: Array<{ job: ImportJob; timer: NodeJS.Timeout }> =
    [];

  private readonly idleWaiters: Array<() => void> = [];

  /** Aborted when the running job is asked to stop (shutdown). */
  private readonly stop = new AbortController();

  private draining: Promise<void> | null = null;

  /** Hand-backs still being written, by import; the drain waits for them. */
  private readonly handingBack = new Map<Promise<void>, string>();

  constructor(
    private readonly runningLimit = IMPORTS_RUNNING_PER_REPLICA,
    private readonly waitingLimit = IMPORTS_WAITING_PER_REPLICA,
    private readonly heartbeatMs = WAITING_HEARTBEAT_MS,
  ) {}

  /**
   * Holds a place before the upload is validated and its record opened, so
   * a full replica refuses it with nothing written. Synchronous on purpose:
   * two requests can never both take the last place.
   */
  reserve(): ImportTicket {
    if (this.draining) {
      // The same answer as a full replica, which every client already
      // handles: send it again in a moment. By then the balancer has taken
      // this replica out of rotation. Worded for both doors that reserve
      // here — an upload and a large undo, which sends no file.
      throw new ServiceBusyError(
        "Este servidor está reiniciando. Tente de novo em instantes.",
        "IMPORT_BUSY",
        IMPORT_RETRY_AFTER_SECONDS,
        429,
      );
    }

    const taken = this.active.size + this.waiting.length + this.reserved;

    if (taken >= this.runningLimit + this.waitingLimit) {
      throw new ServiceBusyError(
        "Há muitas importações sendo processadas agora. Tente de novo em instantes.",
        "IMPORT_BUSY",
        IMPORT_RETRY_AFTER_SECONDS,
        429,
      );
    }

    this.reserved += 1;

    let settled = false;

    const settle = () => {
      if (settled) return false;
      settled = true;
      this.reserved -= 1;

      return true;
    };

    return {
      submit: (job) => {
        if (!settle()) return;

        // Reserved before the shutdown began, submitted after: its record is
        // open and will never be processed here.
        if (this.draining) {
          this.handBack(job, "waiting");
          this.notifyIfIdle();

          return;
        }

        const timer = setInterval(() => {
          job
            .heartbeat()
            .catch((error) =>
              log.warn(
                { err: error, importId: job.importId },
                "heartbeat of a waiting import failed",
              ),
            );
        }, this.heartbeatMs);

        timer.unref?.();

        this.waiting.push({ job, timer });
        this.pump();
      },
      cancel: () => {
        if (settle()) this.notifyIfIdle();
      },
    };
  }

  /** Uploads processing or waiting on this replica. */
  size(): number {
    return this.active.size + this.waiting.length;
  }

  /** Resolves once nothing is running, waiting or reserved (tests). */
  idle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();

    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /**
   * The replica is going away (see the class comment). Resolves once every
   * job has finished or been handed back: within `graceMs + stopGraceMs +
   * handBackMs`, whatever the database does. Idempotent: a second call joins
   * the first.
   */
  drain(options: ImportDrainOptions): Promise<void> {
    this.draining ??= this.runDrain(options);

    return this.draining;
  }

  private async runDrain({
    graceMs,
    stopGraceMs = IMPORT_STOP_GRACE_MS,
    handBackMs = IMPORT_HANDBACK_WRITE_MS,
  }: ImportDrainOptions): Promise<void> {
    // Runs synchronously up to the first await: by the time `drain` returns,
    // `reserve` refuses and nothing waiting can start.
    for (const { job, timer } of this.waiting.splice(0)) {
      clearInterval(timer);
      this.handBack(job, "waiting");
    }

    this.notifyIfIdle();

    if (!(await settlesWithin(this.idle(), graceMs))) {
      log.warn(
        { running: [...this.active].map((job) => job.importId) },
        "asking the running import to stop: the replica is shutting down",
      );

      this.stop.abort();

      if (!(await settlesWithin(this.idle(), stopGraceMs))) {
        for (const job of this.active) this.handBack(job, "running");
      }
    }

    // Bounded like the rest: a database that stopped answering would hold
    // these up to the pool timeout and push the workers past the watchdog.
    if (
      this.handingBack.size > 0 &&
      !(await settlesWithin(
        Promise.allSettled([...this.handingBack.keys()]),
        handBackMs,
      ))
    ) {
      log.warn(
        { pending: [...this.handingBack.values()], waitedMs: handBackMs },
        "import hand-backs not written in time; the abandoned-import sweep will close them",
      );
    }
  }

  /** Runs `job.abandon` once, logged, tracked until written. */
  private handBack(job: ImportJob, stage: AbandonedStage): void {
    log.warn(
      { importId: job.importId, stage },
      "import handed back: the replica is shutting down",
    );

    const written: Promise<void> = Promise.resolve()
      .then(() => job.abandon(stage))
      .catch((error) =>
        log.error(
          { err: error, importId: job.importId, stage },
          "could not hand an import back; the abandoned-import sweep will close it",
        ),
      )
      .finally(() => this.handingBack.delete(written));

    this.handingBack.set(written, job.importId);
  }

  private isIdle(): boolean {
    return (
      this.active.size === 0 && this.waiting.length === 0 && !this.reserved
    );
  }

  private notifyIfIdle(): void {
    if (!this.isIdle()) return;

    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }

  private pump(): void {
    while (
      !this.draining &&
      this.active.size < this.runningLimit &&
      this.waiting.length > 0
    ) {
      const { job, timer } = this.waiting.shift()!;

      clearInterval(timer);
      this.active.add(job);

      // The job closes its record whatever happens; anything that still
      // escapes is logged here, never left as an unhandled rejection.
      Promise.resolve()
        .then(() => job.run(this.stop.signal))
        .catch((error) =>
          log.error(
            { err: error, importId: job.importId },
            "background import failed",
          ),
        )
        .finally(() => {
          this.active.delete(job);
          this.pump();
          this.notifyIfIdle();
        });
    }
  }
}

/**
 * Whether `promise` settles within `ms`. The timer is unref'd: it never keeps
 * a process that is otherwise done alive.
 */
async function settlesWithin(
  promise: Promise<unknown>,
  ms: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;

  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, ms));
    timer.unref?.();
  });

  try {
    return await Promise.race([promise.then(() => true as const), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** This replica's queue, shared by every upload route. */
const importQueue = new ImportQueue();

export {
  IMPORTS_RUNNING_PER_REPLICA,
  IMPORTS_WAITING_PER_REPLICA,
  IMPORT_HANDBACK_WRITE_MS,
  IMPORT_RETRY_AFTER_SECONDS,
  IMPORT_STOP_GRACE_MS,
  ImportQueue,
  importQueue,
  type AbandonedStage,
  type ImportDrainOptions,
  type ImportJob,
  type ImportTicket,
};
