import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { CloseRouteWithPendingUseCase } from "./close-route-with-pending-usecase";

import {
  closeRouteWithPendingSchema,
  routeIdParamSchema,
} from "@/schemas/route-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

class CloseRouteWithPendingController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { routeId } = routeIdParamSchema.parse(request.params);

    const { reason } = closeRouteWithPendingSchema.parse(request.body);

    const useCase = container.resolve(CloseRouteWithPendingUseCase);

    const { route, cancelledStops, unchanged } = await useCase.execute({
      userId: id,
      businessId,
      routeId,
      reason,
    });

    return reply.status(200).send({
      message: unchanged
        ? "A rota já estava encerrada com pendências."
        : "Rota encerrada com pendências.",
      data: {
        id: route.id,
        status: route.status,
        completed_at: route.completed_at,
        closure_reason: route.closure_reason ?? null,
        cancelledStops,
        planVersion: route.plan_version,
        unchanged,
      },
    });
  }
}

export { CloseRouteWithPendingController };
