import ExcelJS from "exceljs";

import { FastifyReply } from "fastify";

import { cpuPool } from "@/shared/cpu-pool";
import type { CpuPool, WorkbookSession } from "@/shared/cpu-pool/cpu-pool";

import { ExportColumn, ExportWriter } from "../types";

import { ExportAbortedError } from "./csv-writer";

/**
 * Rows per message to the CPU pool's thread: big enough that the messages
 * cost nothing next to the rows, small enough that the thread never holds
 * more than a few hundred rows' worth of text.
 */
const ROWS_PER_BATCH = 500;

/**
 * The Excel export's writer.
 *
 * Since plano-escala F3-29 the workbook is built on a thread of the CPU
 * pool (src/shared/cpu-pool): ExcelJS turns every row into XML and zips the
 * file synchronously, on whichever thread runs it, for the whole download.
 * Here the rows go to the thread in batches, and its bytes come back to be
 * written on the socket. The pool is asked before the headers: a pool that
 * is full is still a plain 503 CPU_POOL_BUSY the client can show. With
 * CPU_POOL_THREADS=0, or without the thread's file, the workbook is built
 * here, as before.
 */
class ExcelWriter implements ExportWriter {
  private workbook: ExcelJS.stream.xlsx.WorkbookWriter | null = null;
  private worksheet: ExcelJS.Worksheet | null = null;

  private session: WorkbookSession | null = null;
  private batch: Array<Record<string, unknown>> = [];

  private reply!: FastifyReply;

  constructor(private readonly pool: CpuPool = cpuPool) {}

  async start(reply: FastifyReply, columns: ExportColumn[], filename: string) {
    this.reply = reply;
    const res = reply.raw;

    if (this.pool.enabled()) {
      this.session = await this.pool.openWorkbook(
        columns.map((column) => ({
          header: column.header,
          key: column.key,
          width: column.width,
        })),
        (bytes) => {
          if (!res.destroyed) res.write(bytes);
        },
      );

      // A download that ends early (the client left, a failure after the
      // 200) gives the thread back at once.
      res.once("close", () => this.session?.abort());
    }

    // 1. Configure headers at the Node.js level
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}.xlsx"`,
    );
    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");

    // 2. Send the headers before starting ExcelJS
    res.writeHead(200);

    if (this.session) return;

    /**
     * 3. Initializes WorkbookWriter, pointing to the already open stream.
     *
     * Inline strings, not the shared-strings table. With the table, every
     * distinct text of the file — recipients, addresses, notes: nearly every
     * cell — is kept in memory until the end and written in one synchronous
     * pass at commit: 250k rows ran a 768 MB heap out of memory, and the
     * commit held the event loop for 2–3 s. Inline, each row leaves with its
     * text. The file is somewhat larger before compression and opens the
     * same in Excel, LibreOffice and Sheets.
     */
    this.workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res, // Use the raw stream that already had a writeHead called
      useStyles: true,
      useSharedStrings: false,
    });

    this.worksheet = this.workbook.addWorksheet("Relatório");
    this.worksheet.columns = columns.map((c) => ({
      header: c.header,
      key: c.key,
      width: c.width || 20,
    }));
  }

  /**
   * One row, as the CSV writer does it: a client that went away ends the
   * export, and a client that reads slowly makes it wait.
   *
   * The zip is piped into the socket, so a full socket pauses the pipe, not
   * this loop: rows kept being compressed into memory while the database
   * cursor kept producing them, and a closed socket was never noticed — the
   * whole file was built for nobody.
   */
  async writeRow(row: Record<string, any>) {
    const res = this.reply.raw;

    if (res.destroyed) throw new ExportAbortedError("Client disconnected");

    if (this.session) {
      this.batch.push(row);

      if (this.batch.length >= ROWS_PER_BATCH) {
        const rows = this.batch;

        this.batch = [];
        await this.session.write(rows);
      }
    } else {
      // In stream writing, the commit() function is essential to send the line to the stream
      this.worksheet!.addRow(row).commit();
    }

    if (!res.writableNeedDrain) return;

    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        res.off("drain", onDrain);
        res.off("close", onClose);
        res.off("error", onClose);
      };

      const onDrain = () => {
        cleanup();
        resolve();
      };

      const onClose = () => {
        cleanup();
        reject(new ExportAbortedError("Client disconnected"));
      };

      res.once("drain", onDrain);
      res.once("close", onClose);
      res.once("error", onClose);
    });
  }

  async end() {
    if (this.session) {
      if (this.batch.length > 0) {
        const rows = this.batch;

        this.batch = [];
        await this.session.write(rows);
      }

      // Resolves after the workbook's last byte was handed to the socket.
      await this.session.end();

      if (!this.reply.raw.writableEnded) this.reply.raw.end();

      return;
    }

    // Committing the spreadsheet finalizes the Excel structures
    await Promise.all([this.worksheet!.commit(), this.workbook!.commit()]);

    // ExcelJS WorkbookWriter usually closes the stream automatically,
    // but if it doesn't close, raw.end() ensures it closes
    if (!this.reply.raw.writableEnded) {
      this.reply.raw.end();
    }
  }
}

export { ExcelWriter, ROWS_PER_BATCH };
