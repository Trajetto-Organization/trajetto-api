import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";
import { z } from "zod";

import { ExportFuelUseCase } from "./export-fuel-usecase";
import { exportFuelQuerySchema } from "@/schemas/export-fuel-schema";

import { ExportPipeline } from "@/shared/services/export/export-pipeline";
import { CsvWriter } from "@/shared/services/export/writers/csv-writer";

import { ExcelWriter } from "@/shared/services/export/writers/excel-writer";
import { ExportColumn } from "@/shared/services/export/types";

import { replyFuelWriteError } from "../errors/fuel-http-errors";

class ExportFuelController {
  async handle(request: FastifyRequest, reply: FastifyReply) {
    const { id } = request.user;

    // Validated and transformed by the route (facets arrive as lists).
    const { search, format, businessId, branchId, vehicleId, fuelTypeId } =
      request.query as z.infer<typeof exportFuelQuerySchema>;

    const exportFuelUseCase = container.resolve(ExportFuelUseCase);

    try {
      const { iterator, columns, filename } = await exportFuelUseCase.execute({
        userId: id,
        businessId,
        search,
        branchIds: branchId,
        vehicleIds: vehicleId,
        fuelTypeIds: fuelTypeId,
      });

      // Choose writer
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
      // 400 NOTHING_TO_EXPORT when the filter keeps nothing; the web shows
      // the sentence, never the raw body.
      if (replyFuelWriteError(reply, error)) return;

      throw error;
    }
  }
}

export { ExportFuelController };
