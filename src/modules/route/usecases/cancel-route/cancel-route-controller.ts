import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { CancelRouteUseCase } from "./cancel-route-usecase";

import { cancelRouteSchema, routeIdParamSchema } from "@/schemas/route-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

class CancelRouteController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { routeId } = routeIdParamSchema.parse(request.params);

    const { reason } = cancelRouteSchema.parse(request.body);

    const cancelRouteUseCase = container.resolve(CancelRouteUseCase);

    await cancelRouteUseCase.execute({
      userId: id,
      businessId,
      routeId,
      reason,
    });

    return reply.status(200).send({ message: "Rota cancelada." });
  }
}

export { CancelRouteController };
