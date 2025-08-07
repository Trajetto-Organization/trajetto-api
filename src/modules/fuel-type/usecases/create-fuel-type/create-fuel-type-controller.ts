import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { CreateFuelTypeUseCase } from "./create-fuel-type-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { createFuelTypeSchema } from "@/schemas/create-fuel-type-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

import { FuelTypeAlreadyExistsError } from "../errors/fuel-type-already-exists-error";

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
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof FuelTypeAlreadyExistsError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { CreateFuelTypeController };
