import { FastifyRequest, FastifyReply } from "fastify";
import { container } from "tsyringe";

import { DeleteFuelUseCase } from "./delete-fuel-usecase";

import { updateDeleteFuelSchema } from "@/schemas/update-delete-fuel-schema";

import { replyFuelWriteError } from "../errors/fuel-http-errors";

class DeleteFuelController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { businessId, fuelId } = updateDeleteFuelSchema.parse(request.params);
    const deleteFuelUseCase = container.resolve(DeleteFuelUseCase);

    try {
      await deleteFuelUseCase.execute(
        {
          fuelId,
          businessId,
        },
        id,
      );

      return reply.status(200).send({
        message: "Abastecimento excluído com sucesso!",
      });
    } catch (error) {
      // Missing or another company's refueling: 404 FUEL_NOT_FOUND. A driver
      // token: 403 DRIVER_CANNOT_DELETE_FUEL (fuel-http-errors).
      if (replyFuelWriteError(reply, error)) return;

      throw error;
    }
  }
}

export { DeleteFuelController };
