import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { RemoveRouteStopsUseCase } from "./remove-route-stops-usecase";

import {
  removeRouteStopsSchema,
  routeIdParamSchema,
} from "@/schemas/route-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

class RemoveRouteStopsController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { routeId } = routeIdParamSchema.parse(request.params);

    const { stopIds, expectedPlanVersion } = removeRouteStopsSchema.parse(
      request.body,
    );

    const useCase = container.resolve(RemoveRouteStopsUseCase);

    const result = await useCase.execute({
      userId: id,
      businessId,
      routeId,
      stopIds,
      expectedPlanVersion,
    });

    return reply.status(200).send({
      message:
        result.removed.length === 0
          ? "Nenhuma parada a remover: elas já não estavam nesta rota."
          : "Paradas removidas da rota.",
      data: {
        removed: result.removed.map((entry) => entry.stopId),
        alreadyGone: result.alreadyGone,
        planVersion: result.planVersion,
        routeEmptied: result.routeEmptied,
      },
    });
  }
}

export { RemoveRouteStopsController };
