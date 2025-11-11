import { FastifyReply, FastifyRequest } from "fastify";

import { container } from "tsyringe";
import { CreateVehicleAssignmentUseCase } from "./create-vehicle-assignment-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";
import { DriverNotFoundError } from "@/modules/driver/usecases/errors/driver-not-found-error";

import { RouteNotFoundError } from "@/modules/routing/usecases/errors/route-not-found-error";
import { VehicleAlreadyAssignedError } from "../errors/vehicle-already-assigned-error";

import {
  createVehicleAssignmentSchema,
  businessIdParamSchema,
} from "@/routes/documentation/vehicle-assignment-schemas";

class CreateVehicleAssignmentController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply> {
    const { id: userId } = request.user;
    const { businessId } = businessIdParamSchema.parse(request.params);

    const vehicleAssignmentData = createVehicleAssignmentSchema.parse(
      request.body,
    );

    const createAssignmentUseCase = container.resolve(
      CreateVehicleAssignmentUseCase,
    );

    try {
      const assignment = await createAssignmentUseCase.execute(
        {
          ...vehicleAssignmentData,
          businessId,
        },
        userId,
      );

      return reply.status(201).send({
        message: "Atribuição criada com sucesso!",
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

      if (error instanceof RouteNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof VehicleAlreadyAssignedError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { CreateVehicleAssignmentController };
