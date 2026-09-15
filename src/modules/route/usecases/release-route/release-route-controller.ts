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

    const { released } = releaseRouteSchema.parse(request.body ?? {});

    const releaseRouteUseCase = container.resolve(ReleaseRouteUseCase);

    await releaseRouteUseCase.execute({
      userId: id,
      businessId,
      routeId,
      released,
    });

    return reply.status(200).send({
      message: released
        ? "Rota liberada para o motorista!"
        : "Rota devolvida ao planejamento!",
    });
  }
}

export { ReleaseRouteController };
