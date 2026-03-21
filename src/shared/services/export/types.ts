import { FastifyReply } from "fastify";

interface ExportColumn {
  header: string;
  key: string;
  width?: number;
  formatter?: (value: any, row?: any) => any;
}

interface ExportWriter {
  start(
    reply: FastifyReply,
    columns: ExportColumn[],
    filename: string,
  ): Promise<void>;
  writeRow(row: Record<string, any>): Promise<void>;
  end(): Promise<void>;
}

export { ExportColumn, ExportWriter };
