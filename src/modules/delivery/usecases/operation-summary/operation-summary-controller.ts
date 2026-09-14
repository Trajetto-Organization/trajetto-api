import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { OperationSummaryUseCase } from "./operation-summary-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { operationSummarySchema } from "@/schemas/operation-summary-schema";

class OperationSummaryController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId } = operationSummarySchema.parse(request.query);

    const operationSummaryUseCase = container.resolve(OperationSummaryUseCase);

    try {
      const summary = await operationSummaryUseCase.execute({
        userId: id,
        businessId,
      });

      return reply.status(200).send({ data: summary });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { OperationSummaryController };
