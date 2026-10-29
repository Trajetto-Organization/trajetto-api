import ExcelJS from "exceljs";

import { FastifyReply } from "fastify";
import { ExportColumn, ExportWriter } from "../types";

import { ExportAbortedError } from "./csv-writer";

class ExcelWriter implements ExportWriter {
  private workbook!: ExcelJS.stream.xlsx.WorkbookWriter;
  private worksheet!: ExcelJS.Worksheet;

  private reply!: FastifyReply;

  async start(reply: FastifyReply, columns: ExportColumn[], filename: string) {
    this.reply = reply;
    const res = reply.raw;

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

    // In stream writing, the commit() function is essential to send the line to the stream
    this.worksheet.addRow(row).commit();

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
    // Committing the spreadsheet finalizes the Excel structures
    await Promise.all([this.worksheet.commit(), this.workbook.commit()]);

    // ExcelJS WorkbookWriter usually closes the stream automatically,
    // but if it doesn't close, raw.end() ensures it closes
    if (!this.reply.raw.writableEnded) {
      this.reply.raw.end();
    }
  }
}

export { ExcelWriter };
