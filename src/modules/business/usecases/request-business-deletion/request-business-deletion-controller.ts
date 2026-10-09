import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { RequestBusinessDeletionUseCase } from "./request-business-deletion-usecase";

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

    const result = await requestBusinessDeletionUseCase.execute(
      businessId,
      id,
    );

    return reply.status(200).send(result);
  }
}

export { RequestBusinessDeletionController };
