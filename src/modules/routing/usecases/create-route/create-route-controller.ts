import { FastifyRequest, FastifyReply } from "fastify";
import { container } from "tsyringe";

import { CreateRouteUseCase } from "./create-route-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";
import { DriverNotFoundError } from "@/modules/driver/usecases/errors/driver-not-found-error";

import { createRouteSchema } from "@/schemas/create-route-schema";

class CreateRouteController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply> {
    const { id } = request.user;
    const routeData = createRouteSchema.parse(request.body);

    const createRouteUseCase = container.resolve(CreateRouteUseCase);

    try {
      const result = await createRouteUseCase.execute(routeData, id);

      return reply.status(201).send({
        message: "Rota criada com sucesso!",
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

      throw error;
    }
  }
}

export { CreateRouteController };
