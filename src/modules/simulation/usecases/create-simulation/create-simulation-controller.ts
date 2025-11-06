import { FastifyRequest, FastifyReply } from "fastify";
import { container } from "tsyringe";

import { CreateSimulationUseCase } from "./create-simulation-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { createSimulationSchema } from "@/schemas/create-simulation-schema";

class CreateSimulationController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply> {
    const { id } = request.user;
    const simulationData = createSimulationSchema.parse(request.body);

    const createSimulationUseCase = container.resolve(CreateSimulationUseCase);

    try {
      const result = await createSimulationUseCase.execute(simulationData, id);

      return reply.status(201).send({
        message: "Simulação criada com sucesso!",
        simulation: result,
      });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { CreateSimulationController };
