import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { UpdateFuelTypeUseCase } from "./update-fuel-type-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { FuelTypeNotFoundError } from "../errors/fuel-type-not-found-error";
import { FuelTypeAlreadyExistsError } from "../errors/fuel-type-already-exists-error";

import { updateFuelTypeSchema } from "@/schemas/update-fuel-type-schema";
import { FuelTypeNotBelongBusinessError } from "../errors/fuel-type-not-belong-business-error";

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
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof FuelTypeNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof FuelTypeAlreadyExistsError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof FuelTypeNotBelongBusinessError) {
        return reply.status(403).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { UpdateFuelTypeController };
