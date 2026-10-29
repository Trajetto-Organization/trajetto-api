import { FastifyReply } from "fastify";
import { ExportColumn, ExportWriter } from "../types";

/**
 * A cell Excel or Sheets would run as a formula.
 *
 * Quoting a CSV field does not stop that: the quotes are the CSV's delimiter,
 * not an escape the spreadsheet honours. Names, notes, addresses and "received
 * by" come from users, drivers and NF-e files, so a recipient called
 * `=HYPERLINK("https://…","Clique")` — or worse — ran on the machine of the
 * dispatcher who opened the export. The OWASP remedy: a leading apostrophe,
 * which the spreadsheet shows as text and hides.
 *
 * Plain numbers are left alone: "-150" is a debt, not a formula, and turning
 * every negative amount into text would break the sums the export is for.
 */
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[+-]?\d+([.,]\d+)*$/;

function neutralizeFormula(value: string): string {
  return FORMULA_TRIGGER.test(value) && !PLAIN_NUMBER.test(value)
    ? `'${value}`
    : value;
}

/** The client went away mid-export; the pipeline stops pulling rows. */
class ExportAbortedError extends Error {}

class CsvWriter implements ExportWriter {
  private reply!: FastifyReply;
  private delimiter = ";";

  private columns: ExportColumn[] = [];

  async start(reply: FastifyReply, columns: ExportColumn[], filename: string) {
    this.reply = reply;
    this.columns = columns;

    // 1. Use the 'raw' object (http.ServerResponse) to ensure delivery
    const res = reply.raw;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}.csv"`,
    );

    // Optional: Add this header to help the front-end
    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");

    // 2. Set the status and send the headers IMMEDIATELY
    res.writeHead(200);

    // 3. Start the response body (GOOD for Excel to recognize UTF-8)
    res.write("﻿");

    const headerLine = columns
      .map((c) => this.cell(c.header))
      .join(this.delimiter);

    await this.write(headerLine + "\n");
  }

  async writeRow(row: Record<string, any>) {
    const line = this.columns
      .map((c) => this.cell(row[c.key] ?? ""))
      .join(this.delimiter);

    await this.write(line + "\n");
  }

  async end() {
    // Manually terminate the stream
    this.reply.raw.end();
  }

  private cell(value: unknown): string {
    // Escape quotation marks to avoid breaking the CSV file
    const escaped = neutralizeFormula(String(value)).replace(/"/g, '""');

    return `"${escaped}"`;
  }

  /**
   * Waits for the socket when its buffer is full.
   *
   * `write` returning false means "stop until drain"; ignoring it let a
   * client that reads slowly — or not at all — make the process buffer the
   * whole export in memory while the database cursor kept producing rows. A
   * client that disconnects ends the export instead of waiting forever.
   */
  private async write(chunk: string): Promise<void> {
    const res = this.reply.raw;

    if (res.destroyed) throw new ExportAbortedError("Client disconnected");

    if (res.write(chunk)) return;

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
}

export { CsvWriter, ExportAbortedError, neutralizeFormula };
