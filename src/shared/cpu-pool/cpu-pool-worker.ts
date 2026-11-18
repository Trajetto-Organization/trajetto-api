import { PassThrough } from "node:stream";
import { parentPort } from "node:worker_threads";

import ExcelJS from "exceljs";

import { NFeParseError, parseNFeXml } from "@/shared/delivery/nfe-parser";

import type { CpuPoolReply, CpuPoolRequest } from "./cpu-pool-protocol";

/**
 * A thread of the CPU pool (plano-escala F3-29; see cpu-pool.ts).
 *
 * Kept small on purpose: this file is its own build entry, and everything
 * it imports is bundled into it — the NF-e parser and ExcelJS — and
 * nothing else of the API.
 *
 * Two kinds of work:
 *  - a task, one message in and one out: the parse of one NF-e;
 *  - a workbook session, the export's spreadsheet: rows come in batches,
 *    ExcelJS builds and zips the file here, and the bytes go back in chunks
 *    for the main thread to write on the socket. The batch is acknowledged
 *    once its rows are in the workbook, so the main thread sends the next
 *    one only then and the rows never pile up here.
 */

interface Workbook {
  workbook: ExcelJS.stream.xlsx.WorkbookWriter;
  worksheet: ExcelJS.Worksheet;
  out: PassThrough;
}

const workbooks = new Map<number, Workbook>();

function post(reply: CpuPoolReply, transfer: ArrayBuffer[] = []): void {
  parentPort?.postMessage(reply, transfer);
}

function errorOf(error: unknown): { name: string; message: string } {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "Error", message: String(error) };
}

function startWorkbook(id: number, columns: CpuPoolRequest["columns"]): void {
  const out = new PassThrough();

  out.on("data", (chunk: Buffer) => {
    // A copy the thread owns whole, handed over without a second copy.
    const bytes = new Uint8Array(chunk.byteLength);

    bytes.set(chunk);
    post({ type: "chunk", id, bytes }, [bytes.buffer]);
  });
  out.on("end", () => post({ type: "done", id }));

  // Inline strings, as the in-process writer: the shared-strings table
  // keeps every text until the end (excel-writer.ts says why).
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: out,
    useStyles: true,
    useSharedStrings: false,
  });
  const worksheet = workbook.addWorksheet("Relatório");

  worksheet.columns = (columns ?? []).map((column) => ({
    header: column.header,
    key: column.key,
    width: column.width || 20,
  }));

  workbooks.set(id, { workbook, worksheet, out });
}

async function handle(request: CpuPoolRequest): Promise<void> {
  const { id } = request;

  try {
    switch (request.type) {
      case "task": {
        if (request.task !== "nfe-parse") {
          throw new Error(`tarefa desconhecida: ${String(request.task)}`);
        }

        post({ type: "result", id, value: parseNFeXml(String(request.input)) });
        return;
      }

      case "xlsx-start": {
        startWorkbook(id, request.columns);
        post({ type: "ack", id });
        return;
      }

      case "xlsx-rows": {
        const open = workbooks.get(id);

        if (!open) throw new Error("planilha não aberta");

        for (const row of request.rows ?? [])
          open.worksheet.addRow(row).commit();

        post({ type: "ack", id });
        return;
      }

      case "xlsx-end": {
        const open = workbooks.get(id);

        if (!open) throw new Error("planilha não aberta");

        workbooks.delete(id);
        await open.worksheet.commit();
        await open.workbook.commit();
        // "done" follows the last chunk, from the stream's end.
        return;
      }
    }
  } catch (error) {
    workbooks.delete(id);

    // The parse's own refusal is an answer, not a failure of the thread.
    if (error instanceof NFeParseError) {
      post({ type: "result", id, error: errorOf(error) });
      return;
    }

    post({ type: "failed", id, error: errorOf(error) });
  }
}

parentPort?.on("message", (request: CpuPoolRequest) => {
  void handle(request);
});
