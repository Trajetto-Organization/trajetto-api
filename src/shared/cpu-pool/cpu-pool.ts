import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";

import { ServiceBusyError } from "@/shared/errors/service-busy-error";
import { logger } from "@/shared/logging/logger";

import type {
  CpuPoolColumn,
  CpuPoolReply,
  CpuPoolRequest,
  CpuTask,
} from "./cpu-pool-protocol";

const log = logger.child({ component: "cpu-pool" });

/**
 * The CPU pool (plano-escala F3-29): a few worker threads that take the
 * CPU-bound work off the request's event loop, in the mould of the receipt
 * renderer (proof-pdf-renderer.ts):
 *
 *  - the parse of an NF-e (fast-xml-parser, synchronous): 25 of them in
 *    one call held every request and socket of the replica for a second
 *    and more;
 *  - the spreadsheet of an Excel export: ExcelJS builds every row's XML
 *    and zips the file on the thread that runs it, for the whole download.
 *
 * The settings (CPU_POOL_*): CPU_POOL_THREADS threads at most, started on
 * first use, each with a heap of CPU_POOL_THREAD_MAX_OLD_MB (the memory
 * budget of U-15 counts them); CPU_POOL_MAX_PENDING calls waiting for a
 * thread, past which the call is refused at once with 503 CPU_POOL_BUSY
 * and Retry-After; CPU_POOL_TIMEOUT_MS for a call to get a thread, and for
 * a thread to answer — one that does not is terminated and replaced, and
 * its call answered 503. A thread that dies (out of memory, a crash in a
 * parser) takes only its own call with it.
 *
 * A workbook session holds its thread for the whole export, so sessions
 * take at most all threads but one when there are two or more: an export
 * never keeps an NF-e import waiting for its whole download. A session
 * never waits in line either: with every thread it may take already held
 * by another export, `openWorkbook` answers null at once and the caller
 * builds that workbook in process, as before the pool. Waiting would hold
 * the second export for a whole download, or refuse it with 503 after
 * CPU_POOL_TIMEOUT_MS, where it used to run.
 *
 * With CPU_POOL_THREADS=0, or without the worker's file (neither the build
 * nor the source), the callers run the work in process, as before.
 */

interface CpuPoolSettings {
  threads: number;
  maxPending: number;
  timeoutMs: number;
  maxOldMb: number;
}

interface WorkerEntry {
  file: string;
  eval: boolean;
}

interface Thread {
  worker: Worker;
  busy: boolean;
  session: boolean;
}

interface Waiter {
  grant: (thread: Thread) => void;
  fail: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface Call {
  thread: Thread;
  resolve: (reply: CpuPoolReply) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | null;

  /** A session's chunks, in order. */
  onChunk?: (bytes: Buffer) => void;
}

/** What the refusal tells the client to wait. */
const CPU_POOL_RETRY_AFTER_SECONDS = 5;

const busy = () =>
  new ServiceBusyError(
    "O servidor está processando muitos arquivos agora. Tente de novo em alguns segundos.",
    "CPU_POOL_BUSY",
    CPU_POOL_RETRY_AFTER_SECONDS,
  );

const timedOut = () =>
  new ServiceBusyError(
    "O processamento do arquivo demorou demais. Tente de novo.",
    "CPU_POOL_TIMEOUT",
    CPU_POOL_RETRY_AFTER_SECONDS,
  );

const lostThread = () =>
  new ServiceBusyError(
    "O processamento do arquivo foi interrompido. Tente de novo.",
    "CPU_POOL_UNAVAILABLE",
    CPU_POOL_RETRY_AFTER_SECONDS,
  );

/**
 * The thread's file: the bundle tsup builds next to server.js
 * (build/cpu-pool-worker.js), or the source through tsx in development and
 * tests.
 */
function workerEntry(): WorkerEntry | null {
  const built = path.join(__dirname, "cpu-pool-worker.js");
  const source = path.join(__dirname, "cpu-pool-worker.ts");

  if (fs.existsSync(built)) return { file: built, eval: false };

  if (fs.existsSync(source)) {
    return {
      file: `require("tsx/cjs"); require(${JSON.stringify(source)});`,
      eval: true,
    };
  }

  return null;
}

/** An error that came back from a thread, under its own name. */
function rebuild(error: { name: string; message: string }): Error {
  const rebuilt = new Error(error.message);

  rebuilt.name = error.name;

  return rebuilt;
}

class CpuPool {
  private readonly threads = new Set<Thread>();
  private readonly waiting: Waiter[] = [];
  private readonly calls = new Map<number, Call>();
  private nextId = 0;

  constructor(
    private readonly settings: () => CpuPoolSettings,
    private readonly entry: () => WorkerEntry | null = workerEntry,
  ) {}

  /** Whether the work goes to threads; false: the caller runs it here. */
  enabled(): boolean {
    return this.settings().threads > 0 && this.entry() !== null;
  }

  /** Threads started and calls waiting, for the tests and the metrics. */
  state(): { threads: number; busy: number; waiting: number } {
    return {
      threads: this.threads.size,
      busy: [...this.threads].filter((thread) => thread.busy).length,
      waiting: this.waiting.length,
    };
  }

  /** One task on a thread; its answer, or the error it threw there. */
  async run<T>(task: CpuTask, input: unknown): Promise<T> {
    const thread = await this.acquire();

    try {
      const reply = await this.send(thread, { type: "task", task, input });

      if (reply.type === "result" && reply.error) throw rebuild(reply.error);

      return (reply as { value?: unknown }).value as T;
    } finally {
      this.release(thread);
    }
  }

  /**
   * A workbook built on a thread that the session holds until `end` or
   * `abort`; `onChunk` gets the file's bytes in order.
   *
   * Null, at once, when no thread may take a workbook now (the others are
   * held by exports, or the last one is kept for the short tasks): the
   * caller builds the workbook in process. A session never waits in line.
   */
  async openWorkbook(
    columns: CpuPoolColumn[],
    onChunk: (bytes: Buffer) => void,
  ): Promise<WorkbookSession | null> {
    const free = this.freeThreadFor(true);

    if (!free) {
      log.info(
        { threads: this.threads.size, sessions: this.sessions() },
        "No CPU pool thread free for a workbook; it is built in process",
      );

      return null;
    }

    const thread = this.take(free, true);
    const id = (this.nextId += 1);
    let open = true;

    const close = () => {
      if (!open) return;
      open = false;
      this.calls.delete(id);
      this.release(thread);
    };

    try {
      await this.send(thread, { type: "xlsx-start", columns }, id, onChunk);
    } catch (error) {
      close();
      throw error;
    }

    return {
      write: async (rows) => {
        await this.send(thread, { type: "xlsx-rows", rows }, id, onChunk);
      },
      end: async () => {
        try {
          await this.send(thread, { type: "xlsx-end" }, id, onChunk);
        } finally {
          close();
        }
      },
      abort: () => {
        if (!open) return;

        // The rest of the workbook is for nobody: the thread goes, and a
        // fresh one serves the next call.
        this.retire(thread, lostThread());
        close();
      },
    };
  }

  /** Stops every thread. For tests and shutdown. */
  async shutdown(): Promise<void> {
    const threads = [...this.threads];

    for (const thread of threads) this.retire(thread, lostThread());

    for (const waiter of this.waiting.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.fail(lostThread());
    }

    await Promise.all(threads.map((thread) => thread.worker.terminate()));
  }

  private sessionLimit(): number {
    const { threads } = this.settings();

    return threads >= 2 ? threads - 1 : threads;
  }

  private sessions(): number {
    return [...this.threads].filter((thread) => thread.session).length;
  }

  /** A free thread for a task, a new one, or a place in line. */
  private acquire(): Promise<Thread> {
    const settings = this.settings();
    const free = this.freeThreadFor(false);

    if (free) return Promise.resolve(this.take(free, false));

    if (this.waiting.length >= settings.maxPending) {
      return Promise.reject(busy());
    }

    return new Promise<Thread>((resolve, reject) => {
      const waiter: Waiter = {
        grant: resolve,
        fail: reject,
        timer: setTimeout(() => {
          const at = this.waiting.indexOf(waiter);

          if (at >= 0) this.waiting.splice(at, 1);
          reject(busy());
        }, settings.timeoutMs),
      };

      this.waiting.push(waiter);
    });
  }

  private freeThreadFor(session: boolean): Thread | null {
    if (session && this.sessions() >= this.sessionLimit()) return null;

    for (const thread of this.threads) if (!thread.busy) return thread;

    if (this.threads.size < this.settings().threads) return this.start();

    return null;
  }

  private take(thread: Thread, session: boolean): Thread {
    thread.busy = true;
    thread.session = session;

    return thread;
  }

  /** The thread back, to the first in line. */
  private release(thread: Thread): void {
    thread.busy = false;
    thread.session = false;
    this.serveWaiting();
  }

  private serveWaiting(): void {
    for (let at = 0; at < this.waiting.length;) {
      const waiter = this.waiting[at];
      const free = this.freeThreadFor(false);

      if (!free) {
        at += 1;
        continue;
      }

      this.waiting.splice(at, 1);
      clearTimeout(waiter.timer);
      waiter.grant(this.take(free, false));
    }
  }

  private start(): Thread | null {
    const entry = this.entry();

    if (!entry) return null;

    const worker = new Worker(entry.file, {
      eval: entry.eval,
      resourceLimits: { maxOldGenerationSizeMb: this.settings().maxOldMb },
    });

    // Never what keeps the process alive.
    worker.unref();

    const thread: Thread = { worker, busy: false, session: false };

    worker.on("message", (reply: CpuPoolReply) => this.receive(reply));
    worker.on("error", (error: unknown) => {
      log.error({ err: error }, "CPU pool thread failed");
      this.retire(thread, lostThread());
    });
    worker.on("exit", () => this.retire(thread, lostThread()));

    this.threads.add(thread);

    return thread;
  }

  /** A thread gone: its calls fail with `error`, and it leaves the pool. */
  private retire(thread: Thread, error: Error): void {
    if (!this.threads.delete(thread)) return;

    for (const [id, call] of this.calls) {
      if (call.thread !== thread) continue;

      if (call.timer) clearTimeout(call.timer);
      this.calls.delete(id);
      call.reject(error);
    }

    void thread.worker.terminate();
    this.serveWaiting();
  }

  private send(
    thread: Thread,
    request: Omit<CpuPoolRequest, "id">,
    id: number = (this.nextId += 1),
    onChunk?: (bytes: Buffer) => void,
  ): Promise<CpuPoolReply> {
    return new Promise<CpuPoolReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Stuck on this call: everything behind it would wait as long.
        this.calls.delete(id);
        reject(timedOut());
        this.retire(thread, lostThread());
      }, this.settings().timeoutMs);

      this.calls.set(id, { thread, resolve, reject, timer, onChunk });

      try {
        thread.worker.postMessage({ ...request, id });
      } catch (error) {
        clearTimeout(timer);
        this.calls.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private receive(reply: CpuPoolReply): void {
    const call = this.calls.get(reply.id);

    if (!call) return;

    if (reply.type === "chunk") {
      call.onChunk?.(
        Buffer.from(
          reply.bytes.buffer,
          reply.bytes.byteOffset,
          reply.bytes.byteLength,
        ),
      );
      return;
    }

    if (call.timer) clearTimeout(call.timer);

    // A session keeps its entry for its chunks until the session closes.
    if (!call.onChunk) this.calls.delete(reply.id);
    else call.timer = null;

    if (reply.type === "failed") {
      call.reject(rebuild(reply.error));
      return;
    }

    call.resolve(reply);
  }
}

interface WorkbookSession {
  /** A batch of rows; resolves once the thread has them. */
  write(rows: Array<Record<string, unknown>>): Promise<void>;

  /** Closes the workbook; resolves after its last chunk. */
  end(): Promise<void>;

  /** Gives up on the workbook (the client went away). */
  abort(): void;
}

export { CPU_POOL_RETRY_AFTER_SECONDS, CpuPool, workerEntry };
export type { CpuPoolSettings, WorkbookSession, WorkerEntry };
