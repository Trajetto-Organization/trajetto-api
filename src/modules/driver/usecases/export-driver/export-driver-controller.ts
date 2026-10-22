import { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { container } from "tsyringe";

import { ExportDriverUseCase } from "./export-driver-usecase";
import { exportDriverSchema } from "@/schemas/list-driver-schema";

import { ExportPipeline } from "@/shared/services/export/export-pipeline";
import { CsvWriter } from "@/shared/services/export/writers/csv-writer";

import { ExcelWriter } from "@/shared/services/export/writers/excel-writer";
import { ExportColumn } from "@/shared/services/export/types";

class ExportDriverController {
  async handle(request: FastifyRequest, reply: FastifyReply) {
    const { id } = request.user;

    // Validated and transformed by the route (each facet is a list).
    const {
      search,
      format,
      businessId,
      sort,
      order,
      status,
      contract_type,
      cnh_category,
      branchId,
    } = request.query as z.infer<typeof exportDriverSchema>;

    const exportDriverUseCase = container.resolve(ExportDriverUseCase);

    const { iterator, columns, filename } = await exportDriverUseCase.execute({
      userId: id,
      businessId,
      search: search?.trim() || undefined,
      sort,
      order,
      statuses: status,
      contractTypes: contract_type,
      cnhCategories: cnh_category,
      branchIds: branchId,
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

export { ExportDriverController };
