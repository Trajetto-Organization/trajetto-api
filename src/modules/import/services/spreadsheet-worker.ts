import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";

import { env } from "@/env";
import {
  readSpreadsheet,
  type CellMatrix,
} from "@/shared/delivery/spreadsheet-reader";
import { AppError } from "@/shared/errors/AppError";
import { processMemoryBudget } from "@/shared/lifecycle/memory-budget";
import { logger } from "@/shared/logging/logger";

import type { ReadReply, ReadRequest } from "./spreadsheet-read-worker";

const log = logger.child({ component: "import" });

/**
 * Reads an uploaded spreadsheet on a worker thread (plano-escala F3-23b).
 *
 * exceljs loads the whole workbook: hundreds of megabytes of heap and
 * seconds of CPU for a big one (a 20k × 50 sheet cost +329 MB and a second
 * of frozen event loop). On the main thread that froze every request and
 * socket of the replica while it ran, and a workbook heavier than the heap
 * took the whole process down with it — everybody's requests, not only the
 * upload. Here the thread has a heap ceiling of its own
 * (`resourceLimits.maxOldGenerationSizeMb`): a workbook past it ends the
 * thread, the upload gets a sentence that says so, and the replica keeps
 * serving. The main thread only copies the file over and the rows back, a
 * slice at a time.
 *
 * A thread per read, started for the file and gone after it: reads are
 * rare (one import at a time per replica, import-queue.ts), and a fresh
 * thread returns the workbook's memory to the system instead of keeping a
 * heap that grew for the biggest file it ever read.
 *
 * SPREADSHEET_READS_PER_PROCESS threads at most, the rest waiting their
 * turn; the memory budget of the process counts each at its heap ceiling
 * (U-15), and gives the ceiling when the variable does not. With 0, the file is read on the main thread, inside the main
 * heap, as before: a process configured not to read spreadsheets still
 * reads the one that reaches it instead of refusing it.
 */

/**
 * Rows per message back. A thousand rows of the template's 26 columns
 * deserialize in a few milliseconds; the whole matrix of a 20k-row file in
 * one message was a pause of its own on the main thread.
 */
const SPREADSHEET_ROWS_PER_MESSAGE = 1_000;

const outOfMemory = () =>
  new AppError(
    "A planilha é grande demais para ser lida agora; divida em partes ou tente de novo.",
    413,
    "SPREADSHEET_TOO_LARGE",
  );

const timedOut = () =>
  new AppError(
    "A planilha demorou demais para ser lida; divida em partes ou tente de novo.",
    503,
    "SPREADSHEET_READ_TIMEOUT",
  );

interface ReadOptions {
  /** The thread's heap ceiling, in MB (SPREADSHEET_WORKER_MAX_OLD_MB). */
  maxOldMb?: number;

  /** How long the read may take (SPREADSHEET_READ_TIMEOUT_MS). */
  timeoutMs?: number;

  /** Threads at most (SPREADSHEET_READS_PER_PROCESS); 0 reads in process. */
  slots?: number;
}

/**
 * The thread's heap ceiling this process runs with: SPREADSHEET_WORKER_MAX_OLD_MB,
 * or, without it, the room the memory budget leaves per read (U-15,
 * shared/lifecycle/memory-budget.ts), the very figure the boot checked.
 */
function spreadsheetWorkerMaxOldMb(): number {
  return processMemoryBudget(env).parts.spreadsheetMaxOldMb;
}

let warnedInProcess = false;

function readInProcess(
  filename: string,
  base64: string,
  reason: string,
): Promise<CellMatrix> {
  if (!warnedInProcess) {
    warnedInProcess = true;

    log.warn({ reason }, "spreadsheet read on the main thread");
  }

  return readSpreadsheet(filename, base64);
}

/**
 * The thread's entry. Production runs the bundle tsup builds next to
 * server.js (`build/spreadsheet-read-worker.js`, see tsup.config.ts);
 * development and tests run TypeScript through tsx, so the thread loads
 * tsx's require hook before the source. Null when neither exists.
 */
function workerEntry(): { file: string; eval: boolean } | null {
  const built = path.join(__dirname, "spreadsheet-read-worker.js");
  const source = path.join(__dirname, "spreadsheet-read-worker.ts");

  if (fs.existsSync(built)) return { file: built, eval: false };

  if (fs.existsSync(source)) {
    return {
      file: `require("tsx/cjs"); require(${JSON.stringify(source)});`,
      eval: true,
    };
  }

  return null;
}

/** Reads running and waiting for a thread (tests and the budget's view). */
let running = 0;
const waiting: Array<() => void> = [];

async function takeSlot(slots: number): Promise<void> {
  if (running < slots) {
    running += 1;

    return;
  }

  // The releasing read hands its place over directly: `running` stays.
  await new Promise<void>((resolve) => waiting.push(resolve));
}

function giveSlotBack(): void {
  const next = waiting.shift();

  if (next) next();
  else running -= 1;
}

function readOnThread(
  entry: { file: string; eval: boolean },
  request: ReadRequest,
  { maxOldMb, timeoutMs }: { maxOldMb: number; timeoutMs: number },
): Promise<CellMatrix> {
  return new Promise<CellMatrix>((resolve, reject) => {
    const rows: CellMatrix = [];
    let settled = false;

    const worker = new Worker(entry.file, {
      eval: entry.eval,
      workerData: request,
      resourceLimits: { maxOldGenerationSizeMb: maxOldMb },
    });

    const settle = (outcome: () => void) => {
      if (settled) return;

      settled = true;
      clearTimeout(timer);
      outcome();

      // Whatever the outcome, the thread and its heap go now.
      void worker.terminate();
    };

    // The read is somebody's upload: unlike an idle renderer, it keeps the
    // process alive until it ends (the shutdown exits under it anyway).
    const timer = setTimeout(() => settle(() => reject(timedOut())), timeoutMs);

    worker.on("message", (message: ReadReply) => {
      if (message.type === "rows") {
        for (const row of message.rows) rows.push(row);

        return;
      }

      if (message.type === "done") {
        settle(() => resolve(rows));

        return;
      }

      settle(() =>
        reject(
          message.code && message.statusCode
            ? new AppError(message.message, message.statusCode, message.code)
            : new Error(message.message),
        ),
      );
    });

    worker.on("error", (error: Error & { code?: string }) => {
      if (error.code === "ERR_WORKER_OUT_OF_MEMORY") {
        log.warn(
          { filename: request.filename, maxOldMb },
          "spreadsheet read ran out of its heap",
        );

        settle(() => reject(outOfMemory()));

        return;
      }

      settle(() => reject(error));
    });

    worker.on("exit", (code) => {
      settle(() =>
        reject(new Error(`spreadsheet reader stopped (exit code ${code})`)),
      );
    });
  });
}

/**
 * The upload as a matrix of cells, read off the main thread. Throws what
 * readSpreadsheet throws (an AppError for a file refused on purpose, a plain
 * Error for one that does not open), plus the 413 of a workbook past the
 * thread's heap and the 503 of one past the timeout.
 */
async function readSpreadsheetOffThread(
  filename: string,
  base64: string,
  options: ReadOptions = {},
): Promise<CellMatrix> {
  const slots = options.slots ?? env.SPREADSHEET_READS_PER_PROCESS;

  if (slots === 0) {
    return readInProcess(filename, base64, "SPREADSHEET_READS_PER_PROCESS=0");
  }

  const entry = workerEntry();

  if (!entry) {
    return readInProcess(filename, base64, "spreadsheet worker not found");
  }

  await takeSlot(slots);

  try {
    return await readOnThread(
      entry,
      { filename, content: base64, chunkRows: SPREADSHEET_ROWS_PER_MESSAGE },
      {
        maxOldMb: options.maxOldMb ?? spreadsheetWorkerMaxOldMb(),
        timeoutMs: options.timeoutMs ?? env.SPREADSHEET_READ_TIMEOUT_MS,
      },
    );
  } finally {
    giveSlotBack();
  }
}

/** Reads on a thread or waiting for one, right now. */
function spreadsheetReadsInFlight(): { running: number; waiting: number } {
  return { running, waiting: waiting.length };
}

export {
  SPREADSHEET_ROWS_PER_MESSAGE,
  readSpreadsheetOffThread,
  spreadsheetReadsInFlight,
  spreadsheetWorkerMaxOldMb,
};
