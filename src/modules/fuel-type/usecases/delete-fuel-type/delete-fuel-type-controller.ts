import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { DeleteFuelTypeUseCase } from "./delete-fuel-type-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { updateDeleteFuelTypeSchema } from "@/schemas/update-delete-fuel-type-schema";

import { FuelTypeNotBelongBusinessError } from "../errors/fuel-type-not-belong-business-error";
import { FuelTypeHasAssociatedVehiclesError } from "../errors/fuel-type-has-associated-vehicles-error";

import { FuelTypeNotFoundError } from "../errors/fuel-type-not-found-error";

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
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof FuelTypeNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof FuelTypeNotBelongBusinessError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof FuelTypeHasAssociatedVehiclesError) {
        return reply.status(403).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { DeleteFuelTypeController };
