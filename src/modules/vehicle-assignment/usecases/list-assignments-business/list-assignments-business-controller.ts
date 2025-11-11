import { FastifyReply, FastifyRequest } from "fastify";

import { container } from "tsyringe";
import { ListAssignmentsBusinessUseCase } from "./list-assignments-business-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import {
  businessIdParamSchema,
  listAssignmentsQuerySchema,
} from "@/routes/documentation/vehicle-assignment-schemas";

class ListAssignmentsBusinessController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply> {
    const { id: userId } = request.user;
    const { businessId } = businessIdParamSchema.parse(request.params);

    const queryParams = listAssignmentsQuerySchema.parse(request.query);

    const listAssignmentsUseCase = container.resolve(
      ListAssignmentsBusinessUseCase,
    );

    try {
      const result = await listAssignmentsUseCase.execute(
        {
          ...queryParams,
          businessId,
        },
        userId,
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

export { ListAssignmentsBusinessController };
