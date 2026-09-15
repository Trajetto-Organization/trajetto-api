import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { z } from "zod";

import { ExportDeliveryUseCase } from "./export-delivery-usecase";
import { exportDeliverySchema } from "@/schemas/export-delivery-schema";

import { ExportPipeline } from "@/shared/services/export/export-pipeline";
import { CsvWriter } from "@/shared/services/export/writers/csv-writer";

import { ExcelWriter } from "@/shared/services/export/writers/excel-writer";
import { ExportColumn } from "@/shared/services/export/types";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

class ExportDeliveryController {
  async handle(request: FastifyRequest, reply: FastifyReply) {
    const { id } = request.user;

    const { search, format, businessId, status } = request.query as z.infer<
      typeof exportDeliverySchema
    >;

    const exportDeliveryUseCase = container.resolve(ExportDeliveryUseCase);

    try {
      const { iterator, columns, filename } = await exportDeliveryUseCase.execute(
        { userId: id, businessId, search, status },
      );

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

export { ExportDeliveryController };
