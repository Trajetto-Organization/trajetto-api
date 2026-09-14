import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { CreateOccurrenceTypeUseCase } from "./create-occurrence-type-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { OccurrenceTypeNameAlreadyExistsError } from "../errors/occurrence-type-errors";
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

    try {
      await createOccurrenceTypeUseCase.execute(
        { ...occurrenceTypeData, businessId },
        id,
      );

      return reply
        .status(201)
        .send({ message: "Tipo de ocorrência criado com sucesso!" });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof OccurrenceTypeNameAlreadyExistsError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { CreateOccurrenceTypeController };
