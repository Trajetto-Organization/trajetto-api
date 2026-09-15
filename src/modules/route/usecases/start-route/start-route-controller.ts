import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { StartRouteUseCase } from "./start-route-usecase";

import { routeIdParamSchema, startRouteSchema } from "@/schemas/route-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

class StartRouteController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { routeId } = routeIdParamSchema.parse(request.params);

    const { vehicleId } = startRouteSchema.parse(request.body ?? {});

    const startRouteUseCase = container.resolve(StartRouteUseCase);

    const route = await startRouteUseCase.execute({
      userId: id,
      businessId,
      routeId,
      vehicleId,
    });

    return reply.status(200).send({
      message: "Rota iniciada!",
      data: { id: route.id, started_at: route.started_at },
    });
  }
}

export { StartRouteController };
