import { parentPort, workerData } from "node:worker_threads";

import { readSpreadsheet } from "@/shared/delivery/spreadsheet-reader";
import { AppError } from "@/shared/errors/AppError";

/**
 * One spreadsheet read, on a thread of its own (see spreadsheet-worker.ts).
 *
 * Kept tiny on purpose: this file is its own build entry, and everything it
 * imports is bundled into it — the reader, the zip guard and AppError —
 * with exceljs required from node_modules, and nothing from the rest of the
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
  try {
    const rows = await readSpreadsheet(filename, content);

    // In slices, so the main thread deserializes a little at a time between
    // its other work instead of the whole matrix in one pause.
    for (let start = 0; start < rows.length; start += chunkRows) {
      reply({ type: "rows", rows: rows.slice(start, start + chunkRows) });
    }

    reply({ type: "done", total: rows.length });
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
