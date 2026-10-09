import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";
import { ExportVehicleChecklistExcelUseCase } from "./export-vehicle-checklist-usecase";
import { ExportPipeline } from "@/shared/services/export/export-pipeline";
import { CsvWriter } from "@/shared/services/export/writers/csv-writer";
import { ExcelWriter } from "@/shared/services/export/writers/excel-writer";
import { z } from "zod";
import { exportVehicleChecklistSchema } from "@/schemas/list-vehicle-checklist-schema";
import { replyChecklistError } from "../errors/vehicle-checklist-http-errors";

class ExportVehicleChecklistController {
  async handle(request: FastifyRequest, reply: FastifyReply) {
    const { id } = request.user;

    // Validated and transformed by the route (each facet is a list here).
    const { search, format, businessId, overall_condition, branchId, vehicleId } =
      request.query as z.infer<typeof exportVehicleChecklistSchema>;

    const exportVehicleChecklistExcelUseCase = container.resolve(
      ExportVehicleChecklistExcelUseCase,
    );

    try {
      const { iterator, columns, filename } =
        await exportVehicleChecklistExcelUseCase.execute({
          userId: id,
          businessId,
          search,
          conditions: overall_condition,
          branchIds: branchId,
          vehicleIds: vehicleId,
        });

      const writer = format === "excel" ? new ExcelWriter() : new CsvWriter();

      const pipeline = new ExportPipeline(iterator, columns, writer);

      await pipeline.execute(reply, filename);
    } catch (error) {
      if (replyChecklistError(reply, error)) return;

      throw error;
    }
  }
}

export { ExportVehicleChecklistController };
