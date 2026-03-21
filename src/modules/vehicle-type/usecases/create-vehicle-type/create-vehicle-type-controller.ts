import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { CreateVehicleTypeUseCase } from "./create-vehicle-type-usecase";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { createVehicleTypeSchema } from "@/schemas/create-vehicle-type-schema";
import { VehicleTypeAlreadyExistsError } from "../errors/vehicle-type-already-exists-error";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

class CreateVehicleTypeController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);

    const vehicleTypeData = createVehicleTypeSchema.parse(request.body);
    const createVehicleTypeUseCase = container.resolve(
      CreateVehicleTypeUseCase,
    );

    try {
      await createVehicleTypeUseCase.execute(
        {
          ...vehicleTypeData,
          businessId,
        },
        id,
      );

      return reply
        .status(201)
        .send({ message: "Tipo de veículo criado com sucesso!" });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof VehicleTypeAlreadyExistsError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { CreateVehicleTypeController };
