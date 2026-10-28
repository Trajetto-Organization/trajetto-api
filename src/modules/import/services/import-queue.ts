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
 * Nothing here survives the process. A replica that dies mid-upload leaves
 * the record IN_PROGRESS with its heartbeat stopped, and the
 * close-abandoned-imports sweep closes it with what it did (IDEMP-10) — the
 * same path a crash inside the request always had. Waiting uploads are kept
 * alive with the same heartbeat, so the sweep never closes one that is only
 * in line.
 */
const IMPORTS_RUNNING_PER_REPLICA = 1;
const IMPORTS_WAITING_PER_REPLICA = 3;

/** Well inside the sweep's 15 minutes: a waiting upload is not abandoned. */
const WAITING_HEARTBEAT_MS = 2 * 60 * 1000;

/** What the refusal tells the client to wait. */
const IMPORT_RETRY_AFTER_SECONDS = 30;

interface ImportJob {
  importId: string;

  /** Processes the upload. Expected to close its own record, never to throw. */
  run: () => Promise<unknown>;

  /** Keeps the record's heartbeat while the job waits for its turn. */
  heartbeat: () => Promise<void>;
}

interface ImportTicket {
  /** Queues the job the reservation was taken for. */
  submit: (job: ImportJob) => void;

  /** Gives the place back (the upload was refused after all). */
  cancel: () => void;
}

class ImportQueue {
  private running = 0;

  private reserved = 0;

  private readonly waiting: Array<{ job: ImportJob; timer: NodeJS.Timeout }> =
    [];

  private readonly idleWaiters: Array<() => void> = [];

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
    const taken = this.running + this.waiting.length + this.reserved;

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
    return this.running + this.waiting.length;
  }

  /** Resolves once nothing is running, waiting or reserved (tests). */
  idle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();

    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private isIdle(): boolean {
    return this.running === 0 && this.waiting.length === 0 && !this.reserved;
  }

  private notifyIfIdle(): void {
    if (!this.isIdle()) return;

    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }

  private pump(): void {
    while (this.running < this.runningLimit && this.waiting.length > 0) {
      const { job, timer } = this.waiting.shift()!;

      clearInterval(timer);
      this.running += 1;

      // The job closes its record whatever happens; anything that still
      // escapes is logged here, never left as an unhandled rejection.
      Promise.resolve()
        .then(job.run)
        .catch((error) =>
          log.error(
            { err: error, importId: job.importId },
            "background import failed",
          ),
        )
        .finally(() => {
          this.running -= 1;
          this.pump();
          this.notifyIfIdle();
        });
    }
  }
}

/** This replica's queue, shared by every upload route. */
const importQueue = new ImportQueue();

export {
  IMPORTS_RUNNING_PER_REPLICA,
  IMPORTS_WAITING_PER_REPLICA,
  IMPORT_RETRY_AFTER_SECONDS,
  ImportQueue,
  importQueue,
  type ImportJob,
  type ImportTicket,
};
