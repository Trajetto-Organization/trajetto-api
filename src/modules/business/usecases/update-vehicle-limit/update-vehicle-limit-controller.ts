import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { UpdateVehicleLimitUseCase } from "./update-vehicle-limit-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { updateVehicleLimitSchema } from "@/schemas/update-vehicle-limit-schema";

class UpdateVehicleLimitController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);

    const { vehicle_limit } = updateVehicleLimitSchema.parse(request.body);
    const updateVehicleLimitUseCase = container.resolve(
      UpdateVehicleLimitUseCase,
    );

    try {
      const result = await updateVehicleLimitUseCase.execute({
        userId: id,
        businessId,
        vehicle_limit,
      });

      return reply.status(200).send({
        message: "Limite de veículos atualizado com sucesso!",
        data: result,
      });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { UpdateVehicleLimitController };
