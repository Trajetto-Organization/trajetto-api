import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { CreateVehicleTypeUseCase } from "./create-vehicle-type-usecase";

import { createVehicleTypeSchema } from "@/schemas/create-vehicle-type-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

import { replyVehicleTypeError } from "../errors/vehicle-type-http-errors";

class CreateVehicleTypeController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);

    const vehicleTypeData = createVehicleTypeSchema.parse(request.body);
    const createVehicleTypeUseCase = container.resolve(
      CreateVehicleTypeUseCase,
    );

    try {
      await createVehicleTypeUseCase.execute(
        {
          ...vehicleTypeData,
          businessId,
        },
        id,
      );

      return reply
        .status(201)
        .send({ message: "Tipo de veículo criado com sucesso!" });
    } catch (error) {
      // A duplicate name is an AppError (409) and reaches the handler as is.
      if (replyVehicleTypeError(reply, error)) return;

      throw error;
    }
  }
}

export { CreateVehicleTypeController };
