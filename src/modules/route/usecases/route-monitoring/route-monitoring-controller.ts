import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { RouteMonitoringUseCase } from "./route-monitoring-usecase";
import { routeMonitoringSchema } from "@/schemas/driver-position-schema";

class RouteMonitoringController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { businessId, day, page, pageSize } = routeMonitoringSchema.parse(
      request.query,
    );

    const useCase = container.resolve(RouteMonitoringUseCase);

    const board = await useCase.execute({
      userId: id,
      businessId,
      day,
      page,
      pageSize,
    });

    return reply.status(200).send({ data: board });
  }
}

export { RouteMonitoringController };
