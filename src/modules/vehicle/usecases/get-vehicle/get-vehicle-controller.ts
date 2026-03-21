import { FastifyReply, FastifyRequest } from "fastify";

import { z } from "zod";
import { container } from "tsyringe";

import { GetVehicleUseCase } from "./get-vehicle-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { VehicleNotFoundError } from "../errors/vehicle-not-found-error";
import { getVehicleSchema } from "@/schemas/get-vehicle-schema";

class GetVehicleController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { businessId, vehicleId } = request.params as z.infer<
      typeof getVehicleSchema
    >;

    const getVehicleUseCase = container.resolve(GetVehicleUseCase);

    try {
      const getVehicle = await getVehicleUseCase.execute(
        id,
        vehicleId,
        businessId,
      );

      return reply.status(200).send(getVehicle);
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof VehicleNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { GetVehicleController };
