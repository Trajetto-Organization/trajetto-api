import { FastifyReply, FastifyRequest } from "fastify";

import { container } from "tsyringe";
import { UpdateAssignmentUseCase } from "./update-assignment-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";
import { DriverNotFoundError } from "@/modules/driver/usecases/errors/driver-not-found-error";

import { VehicleAssignmentNotFoundError } from "../errors/vehicle-assignment-not-found-error";

import { updateVehicleAssignmentSchema } from "@/schemas/update-vehicle-assignment-schema";
import { vehicleAssignmentParamsSchema } from "@/schemas/vehicle-assignment-params-schema";

class UpdateAssignmentController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply> {
    const { id: userId } = request.user;
    const { businessId, assignmentId } = vehicleAssignmentParamsSchema.parse(
      request.params,
    );

    const updateVehicleAssignmentData = updateVehicleAssignmentSchema.parse(
      request.body,
    );
    const updateAssignmentUseCase = container.resolve(UpdateAssignmentUseCase);

    try {
      const assignment = await updateAssignmentUseCase.execute(
        {
          ...updateVehicleAssignmentData,
          id: assignmentId,
          businessId,
        },
        userId,
      );

      return reply.status(200).send({
        message: "Atribuição atualizada com sucesso!",
        assignment,
      });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof VehicleNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof DriverNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof VehicleAssignmentNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { UpdateAssignmentController };
