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

    // Validated and opened now, processed after this answer: a 20k-row sheet
    // took longer than the edge's 100 s, and the operator saw a 524 while the
    // rows kept being created (import-queue.ts).
    const record = await useCase.start({
      userId: id,
      businessId,
      filename,
      content,
      shipperId,
    });

    // The same envelope the synchronous answer had, with the counters at
    // zero: the client follows the record until it is closed.
    return reply.status(202).send({
      message:
        "Planilha recebida. A importação está em andamento; o relatório aparece em Importações quando terminar.",
      data: {
        id: record.id,
        status: record.status,
        imported: record.imported,
        duplicated: record.duplicated,
        invalid: record.invalid,
        report: record.report,
      },
    });
  }
}

export { ImportDeliverySpreadsheetController };
