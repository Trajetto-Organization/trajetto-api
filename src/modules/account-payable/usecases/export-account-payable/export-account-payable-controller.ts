import { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { container } from "tsyringe";

import { ExportAccountPayableUseCase } from "./export-account-payable-usecase";
import { exportAccountPayableSchema } from "@/schemas/list-account-payable-schema";

import { ExportPipeline } from "@/shared/services/export/export-pipeline";
import { CsvWriter } from "@/shared/services/export/writers/csv-writer";
import { ExcelWriter } from "@/shared/services/export/writers/excel-writer";

class ExportAccountPayableController {
  async handle(request: FastifyRequest, reply: FastifyReply) {
    const { id } = request.user;

    // Validated and transformed by the route (facets are lists already).
    const { businessId, search, status, category, sort, order, format } =
      request.query as z.infer<typeof exportAccountPayableSchema>;

    const useCase = container.resolve(ExportAccountPayableUseCase);

    const { iterator, columns, filename } = await useCase.execute({
      userId: id,
      businessId,
      search,
      statusGroups: status,
      categories: category,
      sort,
      order,
    });

    const writer = format === "excel" ? new ExcelWriter() : new CsvWriter();

    await new ExportPipeline(iterator, columns, writer).execute(
      reply,
      filename,
    );
  }
}

export { ExportAccountPayableController };
