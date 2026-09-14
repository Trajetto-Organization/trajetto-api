import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { UpdateOccurrenceTypeUseCase } from "./update-occurrence-type-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import {
  OccurrenceTypeNotFoundError,
  OccurrenceTypeNameAlreadyExistsError,
  OccurrenceTypeNotBelongBusinessError,
} from "../errors/occurrence-type-errors";

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

    try {
      await updateOccurrenceTypeUseCase.execute({
        userId: id,
        businessId,
        occurrenceTypeId,
        occurrenceTypeData,
      });

      return reply
        .status(200)
        .send({ message: "Tipo de ocorrência atualizado com sucesso!" });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof OccurrenceTypeNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof OccurrenceTypeNameAlreadyExistsError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof OccurrenceTypeNotBelongBusinessError) {
        return reply.status(403).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { UpdateOccurrenceTypeController };
