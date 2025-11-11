import { FastifyReply, FastifyRequest } from "fastify";

import { container } from "tsyringe";
import { GetAssignmentUseCase } from "./get-assignment-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { VehicleAssignmentNotFoundError } from "../errors/vehicle-assignment-not-found-error";
import { getAssignmentParamsSchema } from "@/routes/documentation/vehicle-assignment-schemas";

class GetAssignmentController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply> {
    const { id: userId } = request.user;
    const { businessId, assignmentId } = getAssignmentParamsSchema.parse(
      request.params,
    );

    const getAssignmentUseCase = container.resolve(GetAssignmentUseCase);

    try {
      const assignment = await getAssignmentUseCase.execute(
        assignmentId,
        businessId,
        userId,
      );

      return reply.status(200).send(assignment);
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof VehicleAssignmentNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { GetAssignmentController };
