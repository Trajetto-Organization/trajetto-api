import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { RequestBusinessDeletionUseCase } from "./request-business-deletion-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { BusinessHasChildrenError } from "@/modules/business/usecases/errors/business-has-children-error";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

class RequestBusinessDeletionController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);

    const requestBusinessDeletionUseCase = container.resolve(
      RequestBusinessDeletionUseCase,
    );

    try {
      const result = await requestBusinessDeletionUseCase.execute(
        businessId,
        id,
      );

      return reply.status(200).send(result);
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
        return reply.status(404).send({ message: error.message });
      }

      if (error instanceof BusinessHasChildrenError) {
        return reply.status(409).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { RequestBusinessDeletionController };
