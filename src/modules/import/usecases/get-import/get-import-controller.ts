import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { GetImportUseCase } from "./get-import-usecase";

import { importIdParamSchema } from "@/schemas/import-spreadsheet-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

class GetImportController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { importId } = importIdParamSchema.parse(request.params);

    const useCase = container.resolve(GetImportUseCase);

    const data = await useCase.execute({ userId: id, businessId, importId });

    return reply.status(200).send({ data });
  }
}

export { GetImportController };
