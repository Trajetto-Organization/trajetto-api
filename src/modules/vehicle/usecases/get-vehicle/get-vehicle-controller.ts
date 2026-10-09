import { FastifyReply, FastifyRequest } from "fastify";

import { z } from "zod";
import { container } from "tsyringe";

import { GetVehicleUseCase } from "./get-vehicle-usecase";

import { getVehicleSchema } from "@/schemas/get-vehicle-schema";
import { replyVehicleError } from "../errors/vehicle-http-errors";

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
      // A driver asking for a truck that is not theirs used to escape as a
      // 500; it is a 403 with its own code now.
      if (replyVehicleError(reply, error)) return;

      throw error;
    }
  }
}

export { GetVehicleController };
