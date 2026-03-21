import { FastifyReply } from "fastify";
import { ExportColumn, ExportWriter } from "../types";

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
    res.write("\uFEFF");

    const headerLine = columns.map((c) => c.header).join(this.delimiter);
    res.write(headerLine + "\n");
  }

  async writeRow(row: Record<string, any>) {
    const line = this.columns
      .map((c) => {
        const value = row[c.key] ?? "";

        // Escape quotation marks to avoid breaking the CSV file
        const escaped = String(value).replace(/"/g, '""');
        return `"${escaped}"`;
      })
      .join(this.delimiter);

    this.reply.raw.write(line + "\n");
  }

  async end() {
    // Manually terminate the stream
    this.reply.raw.end();
  }
}

export { CsvWriter };
