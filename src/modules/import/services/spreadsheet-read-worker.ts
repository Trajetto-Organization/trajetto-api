import { parentPort, workerData } from "node:worker_threads";

import { readSpreadsheetRows } from "@/shared/delivery/spreadsheet-reader";
import { AppError } from "@/shared/errors/AppError";

/**
 * One spreadsheet read, on a thread of its own (see spreadsheet-worker.ts).
 *
 * Kept tiny on purpose: this file is its own build entry, and everything it
 * imports is bundled into it — the reader with its row-at-a-time half, the
 * zip guard and AppError — with exceljs and the parts of it that half drives
 * required from node_modules, and nothing from the rest of the
 * API: no database, no logger, no environment. The thread lives for one
 * file and exits, so the workbook's memory goes with it.
 */
interface ReadRequest {
  filename: string;

  /** The upload as the request carried it: base64. */
  content: string;

  /** Rows per message back (see SPREADSHEET_ROWS_PER_MESSAGE). */
  chunkRows: number;
}

type ReadReply =
  | { type: "rows"; rows: unknown[][] }
  /** The rows sent so far are void: exceljs's whole load reads it again. */
  | { type: "restart" }
  | { type: "done"; total: number }
  | {
      type: "error";
      message: string;
      statusCode: number | null;
      code: string | null;
    };

function reply(message: ReadReply): void {
  parentPort?.postMessage(message);
}

async function read({ filename, content, chunkRows }: ReadRequest) {
  let slice: unknown[][] = [];
  let total = 0;

  try {
    // Sent on as they are read, in slices: the thread never holds the
    // matrix (the main thread deserializes a little at a time between its
    // other work), only what the reader needs to go on.
    await readSpreadsheetRows(filename, content, {
      row(values) {
        slice.push(values);
        total += 1;

        if (slice.length >= chunkRows) {
          reply({ type: "rows", rows: slice });
          slice = [];
        }
      },
      restart() {
        slice = [];
        total = 0;
        reply({ type: "restart" });
      },
    });

    if (slice.length > 0) reply({ type: "rows", rows: slice });

    reply({ type: "done", total });
  } catch (error) {
    // A refusal of the reader keeps its sentence and code across the
    // thread (an AppError does not survive the structured clone as one).
    reply(
      error instanceof AppError
        ? {
            type: "error",
            message: error.message,
            statusCode: error.statusCode,
            code: error.code,
          }
        : {
            type: "error",
            message: error instanceof Error ? error.message : String(error),
            statusCode: null,
            code: null,
          },
    );
  }
}

void read(workerData as ReadRequest);

export type { ReadReply, ReadRequest };
