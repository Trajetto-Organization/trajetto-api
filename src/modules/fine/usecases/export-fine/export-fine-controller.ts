import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { z } from "zod";

import { ExportFineUseCase } from "./export-fine-usecase";
import { exportFineQuerySchema } from "@/schemas/export-fine-schema";

import { ExportPipeline } from "@/shared/services/export/export-pipeline";
import { CsvWriter } from "@/shared/services/export/writers/csv-writer";

import { ExcelWriter } from "@/shared/services/export/writers/excel-writer";
import { ExportColumn } from "@/shared/services/export/types";

class ExportFineController {
  async handle(request: FastifyRequest, reply: FastifyReply) {
    const { id } = request.user;

    // Validated and transformed by the route (each facet is already a list).
    const {
      businessId,
      search,
      format,
      status,
      branchId,
      trafficViolationCodeId,
    } = request.query as z.infer<typeof exportFineQuerySchema>;

    const exportFineUseCase = container.resolve(ExportFineUseCase);

    const { iterator, columns, filename } = await exportFineUseCase.execute({
      userId: id,
      businessId,
      search,
      statuses: status,
      branchIds: branchId,
      trafficViolationCodeIds: trafficViolationCodeId,
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

export { ExportFineController };
