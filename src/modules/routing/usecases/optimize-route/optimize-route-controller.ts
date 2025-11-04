import { FastifyRequest, FastifyReply } from "fastify";
import { container } from "tsyringe";

import { OptimizeRouteUseCase } from "./optimize-route-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { RoutingCalculationError } from "../errors/routing-calculation-error";
import { optimizeRouteSchema } from "@/schemas/optimize-route-schema";

class OptimizeRouteController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply> {
    const { id } = request.user;
    const routeData = optimizeRouteSchema.parse(request.body);

    const optimizeRouteUseCase = container.resolve(OptimizeRouteUseCase);

    try {
      const result = await optimizeRouteUseCase.execute(routeData, id);

      return reply.status(200).send({
        message: "Rota otimizada com sucesso!",
        route: result,
      });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof RoutingCalculationError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { OptimizeRouteController };
