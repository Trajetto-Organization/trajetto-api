import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { ImportDeliverySpreadsheetUseCase } from "./import-delivery-spreadsheet-usecase";

import { importSpreadsheetSchema } from "@/schemas/import-spreadsheet-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

class ImportDeliverySpreadsheetController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);

    const { filename, content, shipperId } = importSpreadsheetSchema.parse(
      request.body,
    );

    const useCase = container.resolve(ImportDeliverySpreadsheetUseCase);

    const record = await useCase.execute({
      userId: id,
      businessId,
      filename,
      content,
      shipperId,
    });

    // 200 and not 201: a spreadsheet where every row was a duplicate created
    // nothing, and the operator still needs the report.
    return reply.status(200).send({
      message:
        `${record.imported} entrega(s) importada(s), ` +
        `${record.duplicated} duplicada(s), ${record.invalid} com erro.`,
      data: {
        id: record.id,
        imported: record.imported,
        duplicated: record.duplicated,
        invalid: record.invalid,
        report: record.report,
      },
    });
  }
}

export { ImportDeliverySpreadsheetController };
