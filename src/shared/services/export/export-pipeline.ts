import { FastifyReply } from "fastify";
import { ExportColumn, ExportWriter } from "./types";

class ExportPipeline<T> {
  constructor(
    private iterator: AsyncGenerator<T>,
    private columns: ExportColumn[],
    private writer: ExportWriter,
  ) {}

  async execute(reply: FastifyReply, filename: string) {
    await this.writer.start(reply, this.columns, filename);

    for await (const item of this.iterator) {
      const row: Record<string, any> = {};

      for (const column of this.columns) {
        const value = (item as any)[column.key];
        row[column.key] = column.formatter ? column.formatter(value) : value;
      }

      await this.writer.writeRow(row);
    }

    await this.writer.end();
  }
}

export { ExportPipeline };
