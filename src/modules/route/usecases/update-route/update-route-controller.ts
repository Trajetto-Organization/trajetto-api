import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { UpdateRouteUseCase } from "./update-route-usecase";

import { routeIdParamSchema, updateRouteSchema } from "@/schemas/route-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

class UpdateRouteController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { routeId } = routeIdParamSchema.parse(request.params);

    const body = updateRouteSchema.parse(request.body);

    const updateRouteUseCase = container.resolve(UpdateRouteUseCase);

    await updateRouteUseCase.execute({
      userId: id,
      businessId,
      routeId,
      ...body,
    });

    return reply.status(200).send({ message: "Rota atualizada com sucesso!" });
  }
}

export { UpdateRouteController };
