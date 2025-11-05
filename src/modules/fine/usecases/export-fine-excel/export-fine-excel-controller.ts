import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { ExportFineExcelUseCase } from "./export-fine-excel-usecase";
import { z } from "zod";

class ExportFineExcelController {
  async handle(request: FastifyRequest, reply: FastifyReply) {
    const querySchema = z.object({
      search: z.string().optional(),
    });

    const { search } = querySchema.parse(request.query);
    const { id } = request.user;

    const exportFineExcelUseCase = container.resolve(ExportFineExcelUseCase);
    const result = await exportFineExcelUseCase.execute(id, search);

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

export { ExportFineExcelController };
