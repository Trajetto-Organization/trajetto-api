import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { CreateOccurrenceTypeUseCase } from "./create-occurrence-type-usecase";

import { createOccurrenceTypeSchema } from "@/schemas/create-occurrence-type-schema";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

class CreateOccurrenceTypeController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);

    const occurrenceTypeData = createOccurrenceTypeSchema.parse(request.body);
    const createOccurrenceTypeUseCase = container.resolve(
      CreateOccurrenceTypeUseCase,
    );

    await createOccurrenceTypeUseCase.execute(
      { ...occurrenceTypeData, businessId },
      id,
    );

    return reply
      .status(201)
      .send({ message: "Tipo de ocorrência criado com sucesso!" });
  }
}

export { CreateOccurrenceTypeController };
