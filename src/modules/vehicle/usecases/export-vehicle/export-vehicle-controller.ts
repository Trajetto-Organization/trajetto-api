import { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { container } from "tsyringe";

import { ExportVehicleUseCase } from "./export-vehicle-usecase";
import { exportVehicleSchema } from "@/schemas/list-vehicle-schema";

import { ExportPipeline } from "@/shared/services/export/export-pipeline";
import { CsvWriter } from "@/shared/services/export/writers/csv-writer";

import { ExcelWriter } from "@/shared/services/export/writers/excel-writer";

import { replyVehicleError } from "../errors/vehicle-http-errors";

class ExportVehicleController {
  async handle(request: FastifyRequest, reply: FastifyReply) {
    const { id } = request.user;

    // Validated and transformed by the route (each facet is a list here).
    const { search, format, businessId, status, branchId } =
      request.query as z.infer<typeof exportVehicleSchema>;

    const exportVehicleUseCase = container.resolve(ExportVehicleUseCase);

    try {
      const { iterator, columns, filename } =
        await exportVehicleUseCase.execute({
          userId: id,
          businessId,
          search,
          statuses: status,
          branchIds: branchId,
        });

      const writer = format === "excel" ? new ExcelWriter() : new CsvWriter();

      const pipeline = new ExportPipeline(iterator, columns, writer);

      await pipeline.execute(reply, filename);
    } catch (error) {
      if (replyVehicleError(reply, error)) return;

      throw error;
    }
  }
}

export { ExportVehicleController };
