import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { OperationSummaryUseCase } from "./operation-summary-usecase";

import { operationSummarySchema } from "@/schemas/operation-summary-schema";

class OperationSummaryController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId } = operationSummarySchema.parse(request.query);

    const operationSummaryUseCase = container.resolve(OperationSummaryUseCase);

    const summary = await operationSummaryUseCase.execute({
      userId: id,
      businessId,
    });

    return reply.status(200).send({ data: summary });
  }
}

export { OperationSummaryController };
