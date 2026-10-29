import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { UpdateVehicleTypeUseCase } from "./update-vehicle-type-usecase";

import { updateVehicleTypeSchema } from "@/schemas/update-vehicle-type-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

import { updateDeleteVehicleTypeSchema } from "@/schemas/update-delete-vehicle-type-schema";

import { replyVehicleTypeError } from "../errors/vehicle-type-http-errors";

class UpdateVehicleTypeController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { vehicleTypeId } = updateDeleteVehicleTypeSchema.parse(
      request.params,
    );

    const vehicleTypeData = updateVehicleTypeSchema.parse(request.body);
    const updateVehicleTypeUseCase = container.resolve(
      UpdateVehicleTypeUseCase,
    );

    try {
      await updateVehicleTypeUseCase.execute(
        vehicleTypeData,
        vehicleTypeId,
        id,
        businessId,
      );

      return reply
        .status(200)
        .send({ message: "Tipo de veículo atualizado com sucesso!" });
    } catch (error) {
      if (replyVehicleTypeError(reply, error)) return;

      throw error;
    }
  }
}

export { UpdateVehicleTypeController };
