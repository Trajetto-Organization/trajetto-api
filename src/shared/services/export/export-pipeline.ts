import { FastifyReply } from "fastify";
import { ExportColumn, ExportWriter } from "./types";

import { ExportAbortedError } from "./writers/csv-writer";
import { exportSlots, type ExportSlots } from "./export-slots";

import { logger } from "@/shared/logging/logger";

const log = logger.child({ component: "export" });

/**
 * The company an export reads: the one the MASTER named, or the caller's.
 * Only the key of a concurrency slot — the use case already checked access.
 */
function tenantOf(reply: FastifyReply): string {
  const request = reply.request as
    | {
        query?: { businessId?: unknown };
        user?: { businessId?: string | null };
      }
    | undefined;

  const named = request?.query?.businessId;

  if (typeof named === "string" && named) return named;

  return request?.user?.businessId ?? "platform";
}

class ExportPipeline<T> {
  constructor(
    private iterator: AsyncGenerator<T>,
    private columns: ExportColumn[],
    private writer: ExportWriter,
    private slots: ExportSlots = exportSlots,
  ) {}

  async execute(reply: FastifyReply, filename: string) {
    // Before a byte of the file: a refusal is still a plain 429 EXPORT_BUSY
    // the client can show, and the generator, never started, is closed so
    // nothing it would open stays open.
    let release: () => void;

    try {
      release = this.slots.acquire(tenantOf(reply));
    } catch (error) {
      await this.iterator.return(undefined as never);

      throw error;
    }

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

      /**
       * A failure after the 200 went out (a cursor batch that timed out, the
       * database dropping mid-file) cannot become an error answer any more:
       * the status line and part of the file are already on the wire, and
       * handing the error to the framework left the client waiting on a
       * download that never ended. Cutting the connection is the only
       * signal left: the browser marks the download failed instead of
       * saving half a spreadsheet as if it were whole.
       */
      if (reply.raw.headersSent) {
        log.error(
          { err: error, filename },
          "export failed after the download started; connection closed",
        );

        // No error argument: it would be re-emitted on the socket.
        reply.raw.destroy();

        return;
      }

      throw error;
    } finally {
      release();
    }
  }
}

export { ExportPipeline };
