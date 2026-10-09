import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { DriverTrailUseCase } from "./driver-trail-usecase";
import {
  driverTrailParamSchema,
  driverTrailQuerySchema,
} from "@/schemas/driver-position-schema";

class DriverTrailController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { driverId } = driverTrailParamSchema.parse(request.params);
    const { businessId, day, routeId } = driverTrailQuerySchema.parse(
      request.query,
    );

    const useCase = container.resolve(DriverTrailUseCase);

    const trail = await useCase.execute({
      userId: id,
      driverId,
      businessId,
      day,
      routeId,
    });

    return reply.status(200).send({ data: trail });
  }
}

export { DriverTrailController };
