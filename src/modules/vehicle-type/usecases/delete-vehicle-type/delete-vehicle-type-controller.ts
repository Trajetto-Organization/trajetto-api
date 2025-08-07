import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { DeleteVehicleTypeUseCase } from "./delete-vehicle-type-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { VehicleTypeNotFoundError } from "../errors/vehicle-type-not-found-error";
import { VehicleTypeNotBelongBusinessError } from "../errors/vehicle-type-not-belong-business-error";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { updateDeleteVehicleTypeSchema } from "@/schemas/update-delete-vehicle-type-schema";

class DeleteVehicleTypeController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;

    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { vehicleTypeId } = updateDeleteVehicleTypeSchema.parse(
      request.params,
    );

    const deleteVehicleTypeUseCase = container.resolve(
      DeleteVehicleTypeUseCase,
    );

    try {
      await deleteVehicleTypeUseCase.execute(vehicleTypeId, id, businessId);

      return reply
        .status(200)
        .send({ message: "Tipo de veículo deletado com sucesso!" });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof VehicleTypeNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof VehicleTypeNotBelongBusinessError) {
        return reply.status(403).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { DeleteVehicleTypeController };
