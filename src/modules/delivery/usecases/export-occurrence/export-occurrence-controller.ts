import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { z } from "zod";

import { ExportOccurrenceUseCase } from "./export-occurrence-usecase";
import { exportOccurrenceSchema } from "@/schemas/export-delivery-schema";

import { ExportPipeline } from "@/shared/services/export/export-pipeline";
import { CsvWriter } from "@/shared/services/export/writers/csv-writer";

import { ExcelWriter } from "@/shared/services/export/writers/excel-writer";
import { ExportColumn } from "@/shared/services/export/types";

class ExportOccurrenceController {
  async handle(request: FastifyRequest, reply: FastifyReply) {
    const { id } = request.user;

    // Validated and transformed by the route: each facet is a list.
    const {
      search,
      format,
      businessId,
      severity,
      category,
      occurrenceTypeId,
      deliveryStatus,
    } = request.query as z.infer<typeof exportOccurrenceSchema>;

    const exportOccurrenceUseCase = container.resolve(ExportOccurrenceUseCase);

    const { iterator, columns, filename } =
      await exportOccurrenceUseCase.execute({
        userId: id,
        businessId,
        search,
        severity,
        category,
        occurrenceTypeIds: occurrenceTypeId,
        deliveryStatuses: deliveryStatus,
      });

    const writer = format === "excel" ? new ExcelWriter() : new CsvWriter();

    const pipeline = new ExportPipeline(
      iterator,
      columns as ExportColumn[],
      writer,
    );

    await pipeline.execute(reply, filename);
  }
}

export { ExportOccurrenceController };
