import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { DeleteOccurrenceTypeUseCase } from "./delete-occurrence-type-usecase";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import {
  OccurrenceTypeNotFoundError,
  OccurrenceTypeNotBelongBusinessError,
  OccurrenceTypeInUseError,
} from "../errors/occurrence-type-errors";

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

    try {
      await deleteOccurrenceTypeUseCase.execute({
        userId: id,
        businessId,
        occurrenceTypeId,
      });

      return reply
        .status(200)
        .send({ message: "Tipo de ocorrência excluído com sucesso!" });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof OccurrenceTypeNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof OccurrenceTypeInUseError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof OccurrenceTypeNotBelongBusinessError) {
        return reply.status(403).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { DeleteOccurrenceTypeController };
