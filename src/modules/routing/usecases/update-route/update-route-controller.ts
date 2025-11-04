import { FastifyRequest, FastifyReply } from "fastify";
import { container } from "tsyringe";

import { UpdateRouteUseCase } from "./update-route-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";
import { DriverNotFoundError } from "@/modules/driver/usecases/errors/driver-not-found-error";

import { RouteNotFoundError } from "../errors/route-not-found-error";

import { routeParamsSchema } from "@/schemas/route-params-schema";
import { updateRouteSchema } from "@/schemas/update-route-schema";

class UpdateRouteController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply> {
    const { id } = request.user;

    const { routeId, businessId } = routeParamsSchema.parse(request.params);
    const routeData = updateRouteSchema.parse(request.body);

    const updateRouteUseCase = container.resolve(UpdateRouteUseCase);

    try {
      const result = await updateRouteUseCase.execute(
        {
          id: routeId,
          ...routeData,
        },
        businessId,
        id,
      );

      return reply.status(200).send({
        message: "Rota atualizada com sucesso!",
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

      if (error instanceof DriverNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof RouteNotFoundError) {
        return reply.status(404).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { UpdateRouteController };
