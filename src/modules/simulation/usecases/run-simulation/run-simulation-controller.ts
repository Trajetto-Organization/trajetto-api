import { FastifyRequest, FastifyReply } from "fastify";
import { container } from "tsyringe";

import { RunSimulationUseCase } from "./run-simulation-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { runSimulationSchema } from "@/schemas/run-simulation-schema";

class RunSimulationController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply> {
    const { id } = request.user;
    const simulationData = runSimulationSchema.parse(request.body);

    const runSimulationUseCase = container.resolve(RunSimulationUseCase);

    try {
      const result = await runSimulationUseCase.execute(simulationData, id);

      if (result.status === "completed") {
        return reply.status(201).send({
          message: "Simulação processada com sucesso!",
          simulation: result.simulation,
          status: result.status,
        });
      } else {
        return reply.status(202).send({
          message: result.message,
          simulation: result.simulation,
          status: result.status,
        });
      }
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

export { RunSimulationController };
