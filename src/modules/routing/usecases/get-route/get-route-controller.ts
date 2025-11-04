import { FastifyRequest, FastifyReply } from "fastify";

import { container } from "tsyringe";
import { GetRouteUseCase } from "./get-route-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { RouteNotFoundError } from "../errors/route-not-found-error";
import { routeParamsSchema } from "@/schemas/route-params-schema";

class GetRouteController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply> {
    const { id } = request.user;
    const { routeId, businessId } = routeParamsSchema.parse(request.params);

    const getRouteUseCase = container.resolve(GetRouteUseCase);

    try {
      const result = await getRouteUseCase.execute(routeId, businessId, id);
      return reply.status(200).send(result);
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

export { GetRouteController };
