import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { ReverseImportUseCase } from "./reverse-import-usecase";

import { importIdParamSchema } from "@/schemas/import-spreadsheet-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

class ReverseImportController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { importId } = importIdParamSchema.parse(request.params);

    const useCase = container.resolve(ReverseImportUseCase);

    const result = await useCase.execute({
      userId: id,
      businessId,
      importId,
    });

    const kept = result.keptDeliveries.length + result.keptRoutes.length;

    return reply.status(200).send({
      message:
        `${result.removedDeliveries} entrega(s) e ${result.removedRoutes} rota(s) removida(s)` +
        (kept > 0
          ? `. ${kept} item(ns) foram mantidos porque já tinham movimento.`
          : "."),
      data: result,
    });
  }
}

export { ReverseImportController };
