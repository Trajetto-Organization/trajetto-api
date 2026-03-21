import ExcelJS from "exceljs";

import { FastifyReply } from "fastify";
import { ExportColumn, ExportWriter } from "../types";

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

    // 3. Initializes WorkbookWriter, pointing to the already open stream
    this.workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res, // Use the raw stream that already had a writeHead called
      useStyles: true,
      useSharedStrings: true,
    });

    this.worksheet = this.workbook.addWorksheet("Relatório");
    this.worksheet.columns = columns.map((c) => ({
      header: c.header,
      key: c.key,
      width: c.width || 20,
    }));
  }

  async writeRow(row: Record<string, any>) {
    // In stream writing, the commit() function is essential to send the line to the stream
    this.worksheet.addRow(row).commit();
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
