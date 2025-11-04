import { FastifyRequest, FastifyReply } from "fastify";
import { container } from "tsyringe";

import { CalculateRouteUseCase } from "./calculate-route-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";
import { RoutingCalculationError } from "../errors/routing-calculation-error";

import { calculateRouteSchema } from "@/schemas/calculate-route-schema";

class CalculateRouteController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply> {
    const { id } = request.user;
    const routeData = calculateRouteSchema.parse(request.body);

    const calculateRouteUseCase = container.resolve(CalculateRouteUseCase);

    try {
      const result = await calculateRouteUseCase.execute(routeData, id);

      return reply.status(200).send({
        message: "Rota calculada com sucesso!",
        route: result,
      });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof VehicleNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof RoutingCalculationError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { CalculateRouteController };
