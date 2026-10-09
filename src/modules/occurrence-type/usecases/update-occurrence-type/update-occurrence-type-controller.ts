import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { UpdateOccurrenceTypeUseCase } from "./update-occurrence-type-usecase";

import { updateOccurrenceTypeSchema } from "@/schemas/update-occurrence-type-schema";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { updateDeleteOccurrenceTypeSchema } from "@/schemas/update-delete-occurrence-type-schema";

class UpdateOccurrenceTypeController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { occurrenceTypeId } = updateDeleteOccurrenceTypeSchema.parse(
      request.params,
    );

    const occurrenceTypeData = updateOccurrenceTypeSchema.parse(request.body);
    const updateOccurrenceTypeUseCase = container.resolve(
      UpdateOccurrenceTypeUseCase,
    );

    await updateOccurrenceTypeUseCase.execute({
      userId: id,
      businessId,
      occurrenceTypeId,
      occurrenceTypeData,
    });

    return reply
      .status(200)
      .send({ message: "Tipo de ocorrência atualizado com sucesso!" });
  }
}

export { UpdateOccurrenceTypeController };
