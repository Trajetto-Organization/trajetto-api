import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { CreateVehicleUseCase } from "./create-vehicle-usecase";

import { createVehicleSchema } from "@/schemas/create-vehicle-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

import { replyVehicleError } from "../errors/vehicle-http-errors";

class CreateVehicleController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);

    const vehicleData = createVehicleSchema.parse(request.body);
    const createVehicleUseCase = container.resolve(CreateVehicleUseCase);

    try {
      await createVehicleUseCase.execute(
        {
          ...vehicleData,
          businessId,
        },
        id,
      );

      return reply.status(201).send({ message: "Veículo criado com sucesso!" });
    } catch (error) {
      // Duplicates (409) and the contracted limit are AppErrors and reach the
      // global handler with their own code.
      if (replyVehicleError(reply, error)) return;

      throw error;
    }
  }
}

export { CreateVehicleController };
