import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { DeleteFuelTypeUseCase } from "./delete-fuel-type-usecase";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { updateDeleteFuelTypeSchema } from "@/schemas/update-delete-fuel-type-schema";

import { replyFuelTypeError } from "../errors/fuel-type-http-errors";

class DeleteFuelTypeController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;

    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { fuelTypeId } = updateDeleteFuelTypeSchema.parse(request.params);

    const deleteFuelTypeUseCase = container.resolve(DeleteFuelTypeUseCase);

    try {
      await deleteFuelTypeUseCase.execute(fuelTypeId, id, businessId);
      return reply
        .status(200)
        .send({ message: "Tipo de combustível deletado com sucesso!" });
    } catch (error) {
      // Missing or foreign: 404 FUEL_TYPE_NOT_FOUND; still in use: 409
      // FUEL_TYPE_IN_USE with the count (decision 11.3).
      if (replyFuelTypeError(reply, error)) return reply;

      throw error;
    }
  }
}

export { DeleteFuelTypeController };
