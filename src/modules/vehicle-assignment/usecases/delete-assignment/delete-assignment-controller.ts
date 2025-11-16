import { FastifyReply, FastifyRequest } from "fastify";

import { container } from "tsyringe";
import { DeleteAssignmentUseCase } from "./delete-assignment-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { VehicleAssignmentNotFoundError } from "../errors/vehicle-assignment-not-found-error";
import { vehicleAssignmentParamsSchema } from "@/schemas/vehicle-assignment-params-schema";

class DeleteAssignmentController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply> {
    const { id: userId } = request.user;
    const { businessId, assignmentId } = vehicleAssignmentParamsSchema.parse(
      request.params,
    );

    const deleteAssignmentUseCase = container.resolve(DeleteAssignmentUseCase);

    try {
      const assignment = await deleteAssignmentUseCase.execute(
        assignmentId,
        businessId,
        userId,
      );

      return reply.status(200).send({
        message: "Atribuição removida com sucesso!",
        assignment,
      });
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

export { DeleteAssignmentController };
