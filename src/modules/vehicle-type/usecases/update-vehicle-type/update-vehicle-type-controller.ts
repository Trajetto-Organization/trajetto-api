import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { UpdateVehicleTypeUseCase } from "./update-vehicle-type-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { VehicleTypeNotFoundError } from "../errors/vehicle-type-not-found-error";
import { VehicleTypeAlreadyExistsError } from "../errors/vehicle-type-already-exists-error";

import { VehicleTypeNotBelongBusinessError } from "../errors/vehicle-type-not-belong-business-error";

import { updateVehicleTypeSchema } from "@/schemas/update-vehicle-type-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

import { updateDeleteVehicleTypeSchema } from "@/schemas/update-delete-vehicle-type-schema";

class UpdateVehicleTypeController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;

    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { vehicleTypeId } = updateDeleteVehicleTypeSchema.parse(
      request.params,
    );

    const vehicleTypeData = updateVehicleTypeSchema.parse(request.body);
    const updateVehicleTypeUseCase = container.resolve(
      UpdateVehicleTypeUseCase,
    );

    try {
      await updateVehicleTypeUseCase.execute(
        vehicleTypeData,
        vehicleTypeId,
        id,
        businessId,
      );

      return reply
        .status(200)
        .send({ message: "Tipo de veículo atualizado com sucesso!" });
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

      if (error instanceof VehicleTypeAlreadyExistsError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { UpdateVehicleTypeController };
