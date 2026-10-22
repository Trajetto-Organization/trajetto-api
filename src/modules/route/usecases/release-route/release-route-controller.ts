import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { ReleaseRouteUseCase } from "./release-route-usecase";

import { releaseRouteSchema, routeIdParamSchema } from "@/schemas/route-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

class ReleaseRouteController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { routeId } = routeIdParamSchema.parse(request.params);

    const { released, expectedPlanVersion } = releaseRouteSchema.parse(
      request.body ?? {},
    );

    const releaseRouteUseCase = container.resolve(ReleaseRouteUseCase);

    const { route, unchanged } = await releaseRouteUseCase.execute({
      userId: id,
      businessId,
      routeId,
      released,
      expectedPlanVersion,
    });

    return reply.status(200).send({
      message: unchanged
        ? released
          ? "A rota já estava liberada para o motorista."
          : "A rota já estava em planejamento."
        : released
          ? "Rota liberada para o motorista!"
          : "Rota devolvida ao planejamento!",
      data: {
        unchanged,
        status: route.status,
        planVersion: route.plan_version,
      },
    });
  }
}

export { ReleaseRouteController };
