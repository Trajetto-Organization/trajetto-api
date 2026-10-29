import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { MoveRouteStopsUseCase } from "./move-route-stops-usecase";

import {
  moveRouteStopsSchema,
  routeIdParamSchema,
} from "@/schemas/route-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

class MoveRouteStopsController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { routeId } = routeIdParamSchema.parse(request.params);

    const { deliveryIds, expectedPlanVersion } = moveRouteStopsSchema.parse(
      request.body,
    );

    const useCase = container.resolve(MoveRouteStopsUseCase);

    const result = await useCase.execute({
      userId: id,
      businessId,
      routeId,
      deliveryIds,
      expectedPlanVersion,
    });

    return reply.status(200).send({
      message: "Entregas adicionadas à rota.",
      data: {
        added: result.stops.length,
        stopIds: result.stops.map((stop) => stop.id),
        moved: result.moved,
        alreadyOnRoute: result.alreadyOnRoute,
        cancelledRoutes: result.cancelledRoutes,
        planVersion: result.planVersion,
      },
    });
  }
}

export { MoveRouteStopsController };
