import { FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";

import { container } from "tsyringe";

import { ListFuelByVehicleUseCase } from "./list-fuel-by-vehicle-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";

import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";
import { VehicleNotBelongBusinessError } from "@/modules/vehicle/usecases/errors/vehicle-not-belong-business-error";

import {
  listFuelByVehicleParamsSchema,
  listFuelByVehicleQuerySchema,
} from "@/schemas/list-fuel-by-vehicle-schema";
import { sendAsNDJSON } from "@/config/stream-utils";

class ListFuelByVehicleController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { vehicleId } = request.params as z.infer<
      typeof listFuelByVehicleParamsSchema
    >;

    const { page, pageSize } = request.query as z.infer<
      typeof listFuelByVehicleQuerySchema
    >;

    const listFuelByVehicleUseCase = container.resolve(
      ListFuelByVehicleUseCase,
    );

    try {
      const fuelsPromise = listFuelByVehicleUseCase.execute(
        id,
        vehicleId,
        page,
        pageSize,
      );

      await sendAsNDJSON({
        reply,
        dataPromise: fuelsPromise,
        page,
        pageSize,
      });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof VehicleNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof VehicleNotBelongBusinessError) {
        return reply.status(403).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { ListFuelByVehicleController };
