import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { ExportDriverUseCase } from "./export-driver-usecase";
import { exportReports } from "@/schemas/export-reports-schema";

import { ExportPipeline } from "@/shared/services/export/export-pipeline";
import { CsvWriter } from "@/shared/services/export/writers/csv-writer";

import { ExcelWriter } from "@/shared/services/export/writers/excel-writer";
import { ExportColumn } from "@/shared/services/export/types";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { DriverNoDriversToExportError } from "../errors/driver-no-drivers-to-export-error";

class ExportDriverController {
  async handle(request: FastifyRequest, reply: FastifyReply) {
    const { id } = request.user;
    const { search, format } = exportReports.parse(request.query);

    const exportDriverUseCase = container.resolve(ExportDriverUseCase);

    try {
      const { iterator, columns, filename } = await exportDriverUseCase.execute(
        id,
        search,
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
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof DriverNoDriversToExportError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { ExportDriverController };
