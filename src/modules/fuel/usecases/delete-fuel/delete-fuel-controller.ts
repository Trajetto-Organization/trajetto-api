import { FastifyRequest, FastifyReply } from "fastify";
import { container } from "tsyringe";

import { DeleteFuelUseCase } from "./delete-fuel-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { updateDeleteFuelSchema } from "@/schemas/update-delete-fuel-schema";

import { FuelDriverCannotDeleteFuelError } from "../errors/fuel-driver-cannot-delete-fuel-error";
import { FuelNotBelongBusinessError } from "../errors/fuel-not-belong-business-error";

import { FuelNotFoundError } from "../errors/fuel-not-found-error";

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
      if (error instanceof ResourceNotFoundError) {
        return reply.status(404).send({
          message: error.message,
        });
      }

      if (error instanceof BusinessNotFoundError) {
        return reply.status(404).send({
          message: error.message,
        });
      }

      if (error instanceof FuelNotFoundError) {
        return reply.status(404).send({
          message: error.message,
        });
      }

      if (error instanceof FuelNotBelongBusinessError) {
        return reply.status(403).send({
          message: error.message,
        });
      }

      if (error instanceof FuelDriverCannotDeleteFuelError) {
        return reply.status(400).send({
          message: error.message,
        });
      }

      throw error;
    }
  }
}

export { DeleteFuelController };
