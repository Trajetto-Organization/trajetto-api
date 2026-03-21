import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { ExportVehicleUseCase } from "./export-vehicle-usecase";
import { exportReports } from "@/schemas/export-reports-schema";

import { ExportPipeline } from "@/shared/services/export/export-pipeline";
import { CsvWriter } from "@/shared/services/export/writers/csv-writer";

import { ExcelWriter } from "@/shared/services/export/writers/excel-writer";
import { ExportColumn } from "@/shared/services/export/types";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

class ExportVehicleController {
  async handle(request: FastifyRequest, reply: FastifyReply) {
    const { id } = request.user;
    const { search, format } = exportReports.parse(request.query);

    const exportVehicleUseCase = container.resolve(ExportVehicleUseCase);

    try {
      const { iterator, columns, filename } =
        await exportVehicleUseCase.execute(id, search);

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
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { ExportVehicleController };
