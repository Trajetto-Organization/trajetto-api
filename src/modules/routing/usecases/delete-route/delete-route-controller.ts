import { FastifyRequest, FastifyReply } from "fastify";
import { container } from "tsyringe";

import { DeleteRouteUseCase } from "./delete-route-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { RouteNotFoundError } from "../errors/route-not-found-error";
import { routeParamsSchema } from "@/schemas/route-params-schema";

class DeleteRouteController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply> {
    const { id } = request.user;
    const { routeId, businessId } = routeParamsSchema.parse(request.params);

    const deleteRouteUseCase = container.resolve(DeleteRouteUseCase);

    try {
      const result = await deleteRouteUseCase.execute(routeId, businessId, id);

      return reply.status(200).send({
        message: "Rota deletada com sucesso!",
        route: result,
      });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof RouteNotFoundError) {
        return reply.status(404).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { DeleteRouteController };
