import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { ExportVehicleChecklistExcelUseCase } from "./export-vehicle-checklist-excel-usecase";
import { z } from "zod";

class ExportVehicleChecklistExcelController {
  async handle(request: FastifyRequest, reply: FastifyReply) {
    const querySchema = z.object({
      search: z.string().optional(),
    });

    const { search } = querySchema.parse(request.query);
    const { id } = request.user;

    const exportVehicleChecklistExcelUseCase = container.resolve(
      ExportVehicleChecklistExcelUseCase,
    );
    const result = await exportVehicleChecklistExcelUseCase.execute(id, search);

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

export { ExportVehicleChecklistExcelController };
