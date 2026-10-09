import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { DriverMonitoringUseCase } from "./driver-monitoring-usecase";
import { driverMonitoringSchema } from "@/schemas/driver-position-schema";

class DriverMonitoringController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { businessId, day } = driverMonitoringSchema.parse(request.query);

    const useCase = container.resolve(DriverMonitoringUseCase);

    const board = await useCase.execute({ userId: id, businessId, day });

    return reply.status(200).send({ data: board });
  }
}

export { DriverMonitoringController };
