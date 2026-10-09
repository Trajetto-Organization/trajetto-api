import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { CreateFuelTypeUseCase } from "./create-fuel-type-usecase";

import { createFuelTypeSchema } from "@/schemas/create-fuel-type-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

import { replyFuelTypeError } from "../errors/fuel-type-http-errors";

class CreateFuelTypeController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);

    const fuelTypeData = createFuelTypeSchema.parse(request.body);
    const createFuelTypeUseCase = container.resolve(CreateFuelTypeUseCase);

    try {
      await createFuelTypeUseCase.execute(
        {
          ...fuelTypeData,
          businessId,
        },
        id,
      );

      return reply
        .status(201)
        .send({ message: "Tipo de combustível criado com sucesso!" });
    } catch (error) {
      if (replyFuelTypeError(reply, error)) return reply;

      throw error;
    }
  }
}

export { CreateFuelTypeController };
