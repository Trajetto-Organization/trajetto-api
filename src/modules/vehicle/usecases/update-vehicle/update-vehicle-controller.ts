import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { UpdateVehicleUseCase } from "./update-vehicle-usecase";

import { updateVehicleSchema } from "@/schemas/update-vehicle-schema";

import { updateDeleteVehicleSchema } from "@/schemas/update-delete-vehicle-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

import { replyVehicleError } from "../errors/vehicle-http-errors";

class UpdateVehicleController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { vehicleId } = updateDeleteVehicleSchema.parse(request.params);

    const vehicleData = updateVehicleSchema.parse(request.body);
    const updateVehicleUseCase = container.resolve(UpdateVehicleUseCase);

    try {
      await updateVehicleUseCase.execute(
        vehicleData,
        vehicleId,
        businessId,
        id,
      );

      return reply
        .status(200)
        .send({ message: "Veículo atualizado com sucesso!" });
    } catch (error) {
      // Status rules, duplicates and the contracted limit are AppErrors and
      // reach the global handler with their own code.
      if (replyVehicleError(reply, error)) return;

      throw error;
    }
  }
}

export { UpdateVehicleController };
