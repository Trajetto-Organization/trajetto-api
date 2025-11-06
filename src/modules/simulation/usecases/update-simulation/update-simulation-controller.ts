import { FastifyRequest, FastifyReply } from "fastify";
import { container } from "tsyringe";

import { UpdateSimulationUseCase } from "./update-simulation-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { SimulationNotFoundError } from "../errors/simulation-not-found-error";

import { simulationIdSchema } from "@/schemas/simulation-id-schema";
import { updateSimulationSchema } from "@/schemas/update-simulation-schema";

class UpdateSimulationController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply> {
    const { id } = request.user;

    const { simulationId } = simulationIdSchema.parse(request.params);
    const simulationData = updateSimulationSchema.parse(request.body);

    const updateSimulationUseCase = container.resolve(UpdateSimulationUseCase);

    try {
      const result = await updateSimulationUseCase.execute(
        { id: simulationId, ...simulationData },
        id,
      );

      return reply.status(200).send({
        message: "Simulação atualizada com sucesso!",
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

export { UpdateSimulationController };
