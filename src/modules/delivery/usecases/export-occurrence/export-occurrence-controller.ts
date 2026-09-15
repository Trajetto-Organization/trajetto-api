import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { z } from "zod";

import { ExportOccurrenceUseCase } from "./export-occurrence-usecase";
import { exportDeliverySchema } from "@/schemas/export-delivery-schema";

import { ExportPipeline } from "@/shared/services/export/export-pipeline";
import { CsvWriter } from "@/shared/services/export/writers/csv-writer";

import { ExcelWriter } from "@/shared/services/export/writers/excel-writer";
import { ExportColumn } from "@/shared/services/export/types";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

class ExportOccurrenceController {
  async handle(request: FastifyRequest, reply: FastifyReply) {
    const { id } = request.user;

    const { search, format, businessId } = request.query as z.infer<
      typeof exportDeliverySchema
    >;

    const exportOccurrenceUseCase = container.resolve(ExportOccurrenceUseCase);

    try {
      const { iterator, columns, filename } =
        await exportOccurrenceUseCase.execute({
          userId: id,
          businessId,
          search,
        });

      const writer = format === "excel" ? new ExcelWriter() : new CsvWriter();

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

export { ExportOccurrenceController };
