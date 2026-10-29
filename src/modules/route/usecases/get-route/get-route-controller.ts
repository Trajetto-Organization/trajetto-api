import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { GetRouteUseCase } from "./get-route-usecase";

import { routeIdParamSchema } from "@/schemas/route-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

class GetRouteController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { routeId } = routeIdParamSchema.parse(request.params);

    const getRouteUseCase = container.resolve(GetRouteUseCase);

    const { route, progress, driverPosition, visitedPoints } =
      await getRouteUseCase.execute({
        userId: id,
        businessId,
        routeId,
      });

    return reply.status(200).send({
      data: { ...route, driverPosition, visitedPoints },
      meta: { progress },
    });
  }
}

export { GetRouteController };
