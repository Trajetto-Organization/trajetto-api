import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { UpdateFuelTypeUseCase } from "./update-fuel-type-usecase";

import { replyFuelTypeError } from "../errors/fuel-type-http-errors";

import { updateFuelTypeSchema } from "@/schemas/update-fuel-type-schema";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { updateDeleteFuelTypeSchema } from "@/schemas/update-delete-fuel-type-schema";

class UpdateFuelTypeController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;

    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { fuelTypeId } = updateDeleteFuelTypeSchema.parse(request.params);

    const fuelTypeData = updateFuelTypeSchema.parse(request.body);
    const updateFuelTypeUseCase = container.resolve(UpdateFuelTypeUseCase);

    try {
      await updateFuelTypeUseCase.execute(
        fuelTypeData,
        fuelTypeId,
        id,
        businessId,
      );

      return reply
        .status(200)
        .send({ message: "Tipo de combustível atualizado com sucesso!" });
    } catch (error) {
      if (replyFuelTypeError(reply, error)) return reply;

      throw error;
    }
  }
}

export { UpdateFuelTypeController };
