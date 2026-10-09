import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { DeleteOccurrenceTypeUseCase } from "./delete-occurrence-type-usecase";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { updateDeleteOccurrenceTypeSchema } from "@/schemas/update-delete-occurrence-type-schema";

class DeleteOccurrenceTypeController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { occurrenceTypeId } = updateDeleteOccurrenceTypeSchema.parse(
      request.params,
    );

    const deleteOccurrenceTypeUseCase = container.resolve(
      DeleteOccurrenceTypeUseCase,
    );

    await deleteOccurrenceTypeUseCase.execute({
      userId: id,
      businessId,
      occurrenceTypeId,
    });

    return reply
      .status(200)
      .send({ message: "Tipo de ocorrência excluído com sucesso!" });
  }
}

export { DeleteOccurrenceTypeController };
