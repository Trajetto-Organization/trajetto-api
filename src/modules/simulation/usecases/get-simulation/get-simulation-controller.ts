import { FastifyRequest, FastifyReply } from "fastify";
import { container } from "tsyringe";

import { GetSimulationUseCase } from "./get-simulation-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { SimulationNotFoundError } from "../errors/simulation-not-found-error";

import { simulationIdSchema } from "@/schemas/simulation-id-schema";

class GetSimulationController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply> {
    const { id } = request.user;
    const { simulationId } = simulationIdSchema.parse(request.params);

    const getSimulationUseCase = container.resolve(GetSimulationUseCase);

    try {
      const result = await getSimulationUseCase.execute(simulationId, id);
      return reply.status(200).send({
        simulation: result,
      });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof SimulationNotFoundError) {
        return reply.status(404).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { GetSimulationController };
