import { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { container } from "tsyringe";

import { ExportServiceOrderUseCase } from "./export-service-order-usecase";
import { exportServiceOrderSchema } from "@/schemas/list-service-order-schema";

import { ExportPipeline } from "@/shared/services/export/export-pipeline";
import { CsvWriter } from "@/shared/services/export/writers/csv-writer";

import { ExcelWriter } from "@/shared/services/export/writers/excel-writer";
import { ExportColumn } from "@/shared/services/export/types";

import { replyMaintenanceError } from "../errors/maintenance-http-errors";

class ExportServiceOrderController {
  async handle(request: FastifyRequest, reply: FastifyReply) {
    const { id } = request.user;
    // Validated and transformed by the route (each facet is a list).
    const { search, format, businessId, status, maintenanceType, branchId } =
      request.query as z.infer<typeof exportServiceOrderSchema>;

    const exportServiceOrderUseCase = container.resolve(
      ExportServiceOrderUseCase,
    );

    try {
      const { iterator, columns, filename } =
        await exportServiceOrderUseCase.execute(
          id,
          {
            search,
            statuses: status,
            maintenanceTypes: maintenanceType,
            branchIds: branchId,
          },
          businessId,
        );

      let writer;
      switch (format) {
        case "excel":
          writer = new ExcelWriter();
          break;
        case "csv":
        default:
          writer = new CsvWriter();
      }

      const pipeline = new ExportPipeline(
        iterator,
        columns as ExportColumn[],
        writer,
      );

      await pipeline.execute(reply, filename);
    } catch (error) {
      if (replyMaintenanceError(reply, error)) return;

      throw error;
    }
  }
}

export { ExportServiceOrderController };
