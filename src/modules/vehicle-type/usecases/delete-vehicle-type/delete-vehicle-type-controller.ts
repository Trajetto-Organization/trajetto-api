import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { DeleteVehicleTypeUseCase } from "./delete-vehicle-type-usecase";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { updateDeleteVehicleTypeSchema } from "@/schemas/update-delete-vehicle-type-schema";

import { replyVehicleTypeError } from "../errors/vehicle-type-http-errors";

class DeleteVehicleTypeController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { vehicleTypeId } = updateDeleteVehicleTypeSchema.parse(
      request.params,
    );

    const deleteVehicleTypeUseCase = container.resolve(
      DeleteVehicleTypeUseCase,
    );

    try {
      await deleteVehicleTypeUseCase.execute(vehicleTypeId, id, businessId);

      return reply
        .status(200)
        .send({ message: "Tipo de veículo deletado com sucesso!" });
    } catch (error) {
      // Still on vehicles: an AppError (409 VEHICLE_TYPE_IN_USE).
      if (replyVehicleTypeError(reply, error)) return;

      throw error;
    }
  }
}

export { DeleteVehicleTypeController };
