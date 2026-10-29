import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { RemoveRouteStopUseCase } from "./remove-route-stop-usecase";

import {
  routeIdParamSchema,
  routeStopIdParamSchema,
} from "@/schemas/route-schema";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

class RemoveRouteStopController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { routeId } = routeIdParamSchema.parse(request.params);
    const { stopId } = routeStopIdParamSchema.parse(request.params);

    const removeRouteStopUseCase = container.resolve(RemoveRouteStopUseCase);

    await removeRouteStopUseCase.execute({
      userId: id,
      businessId,
      routeId,
      stopId,
    });

    return reply.status(200).send({ message: "Parada removida da rota." });
  }
}

export { RemoveRouteStopController };
