import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { ReorderRouteStopsUseCase } from "./reorder-route-stops-usecase";

import {
  reorderRouteStopsSchema,
  routeIdParamSchema,
} from "@/schemas/route-schema";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

class ReorderRouteStopsController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { routeId } = routeIdParamSchema.parse(request.params);

    const { orderedStopIds, expectedPlanVersion } =
      reorderRouteStopsSchema.parse(request.body);

    const reorderRouteStopsUseCase = container.resolve(ReorderRouteStopsUseCase);

    const { planVersion } = await reorderRouteStopsUseCase.execute({
      userId: id,
      businessId,
      routeId,
      orderedStopIds,
      expectedPlanVersion,
    });

    return reply.status(200).send({
      message: "Ordem das paradas atualizada.",
      data: { planVersion },
    });
  }
}

export { ReorderRouteStopsController };
