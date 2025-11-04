import { FastifyRequest, FastifyReply } from "fastify";
import { container } from "tsyringe";

import { ListRoutesBusinessUseCase } from "./list-routes-business-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { listRoutesQuerySchema } from "@/schemas/list-routes-query-schema";

class ListRoutesBusinessController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply> {
    const { id } = request.user;

    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { page, limit, search, status } = listRoutesQuerySchema.parse(
      request.query,
    );

    const listRoutesUseCase = container.resolve(ListRoutesBusinessUseCase);

    try {
      const result = await listRoutesUseCase.execute(
        {
          businessId,
          page: page ? parseInt(page) : undefined,
          limit: limit ? parseInt(limit) : undefined,
          search,
          status,
        },
        id,
      );

      return reply.status(200).send(result);
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { ListRoutesBusinessController };
