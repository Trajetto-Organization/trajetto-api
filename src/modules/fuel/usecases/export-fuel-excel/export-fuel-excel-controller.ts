import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { ExportFuelExcelUseCase } from "./export-fuel-excel-usecase";
import { z } from "zod";

class ExportFuelExcelController {
  async handle(request: FastifyRequest, reply: FastifyReply) {
    const querySchema = z.object({
      search: z.string().optional(),
    });

    const { search } = querySchema.parse(request.query);
    const { id } = request.user;

    const exportFuelExcelUseCase = container.resolve(ExportFuelExcelUseCase);

    const result = await exportFuelExcelUseCase.execute(id, search);

    reply
      .header(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      )
      .header(
        "Content-Disposition",
        `attachment; filename="${result.filename}"`,
      )
      .header("X-Total-Records", result.totalRecords.toString())
      .send(result.buffer);
  }
}

export { ExportFuelExcelController };
