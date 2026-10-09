import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { UpdateVehicleLimitUseCase } from "./update-vehicle-limit-usecase";

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

    const result = await updateVehicleLimitUseCase.execute({
      userId: id,
      businessId,
      vehicle_limit,
    });

    return reply.status(200).send({
      message: "Limite de veículos atualizado com sucesso!",
      data: result,
    });
  }
}

export { UpdateVehicleLimitController };
