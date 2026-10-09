import { FastifyReply } from "fastify";
import { ExportColumn, ExportWriter } from "./types";

import { ExportAbortedError } from "./writers/csv-writer";

class ExportPipeline<T> {
  constructor(
    private iterator: AsyncGenerator<T>,
    private columns: ExportColumn[],
    private writer: ExportWriter,
  ) {}

  async execute(reply: FastifyReply, filename: string) {
    try {
      await this.writer.start(reply, this.columns, filename);

      // Leaving this loop early — the client went away — returns the
      // generator, which releases its database cursor.
      for await (const item of this.iterator) {
        const row: Record<string, any> = {};

        for (const column of this.columns) {
          const value = (item as any)[column.key];
          row[column.key] = column.formatter ? column.formatter(value) : value;
        }

        await this.writer.writeRow(row);
      }

      await this.writer.end();
    } catch (error) {
      // Nobody is left to answer: the headers are long gone and so is the
      // socket. Anything else is a real failure and goes up.
      if (error instanceof ExportAbortedError) return;

      throw error;
    }
  }
}

export { ExportPipeline };
