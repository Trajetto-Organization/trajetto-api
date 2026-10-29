import { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { container } from "tsyringe";
import { GetPreviousFuelUseCase } from "./get-previous-fuel-usecase";

import { replyFuelVehicleReadError } from "../errors/fuel-http-errors";
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
      // Missing and another company's vehicle answer alike, 404 (decision
      // 11.3); a driver's vehicle they may not operate, 403.
      if (replyFuelVehicleReadError(reply, error)) return;

      throw error;
    }
  }
}

export { GetPreviousFuelController };
