import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { DeleteVehicleUseCase } from "./delete-vehicle-usecase";

import { updateDeleteVehicleSchema } from "@/schemas/update-delete-vehicle-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

import { replyVehicleError } from "../errors/vehicle-http-errors";

class DeleteVehicleController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { vehicleId } = updateDeleteVehicleSchema.parse(request.params);

    const deleteVehicleUseCase = container.resolve(DeleteVehicleUseCase);

    try {
      await deleteVehicleUseCase.execute(vehicleId, businessId, id);

      return reply
        .status(200)
        .send({ message: "Veículo deletado com sucesso!" });
    } catch (error) {
      // Still referenced → 409 with the counts in the message; the history
      // guard (deliveries/routes) used to escape as a 500.
      if (replyVehicleError(reply, error)) return;

      throw error;
    }
  }
}

export { DeleteVehicleController };
