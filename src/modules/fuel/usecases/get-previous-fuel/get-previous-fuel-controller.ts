import { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { container } from "tsyringe";
import { GetPreviousFuelUseCase } from "./get-previous-fuel-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";
import {
  getPreviousFuelParamsSchema,
  getPreviousFuelQuerySchema,
} from "@/schemas/fuel-previous-schema";

class GetPreviousFuelController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { vehicleId } = request.params as z.infer<
      typeof getPreviousFuelParamsSchema
    >;
    const { date, businessId } = request.query as z.infer<
      typeof getPreviousFuelQuerySchema
    >;

    const getPreviousFuelUseCase = container.resolve(GetPreviousFuelUseCase);

    try {
      const previousFuel = await getPreviousFuelUseCase.execute(
        id,
        vehicleId,
        date,
        businessId,
      );

      // Return 200 with null if no previous fuel is found (not an error)
      return reply.status(200).send(previousFuel);
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

export { GetPreviousFuelController };
