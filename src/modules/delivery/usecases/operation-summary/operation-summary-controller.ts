import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import {
  OperationSummaryUseCase,
  operationSummarySnapshot,
} from "./operation-summary-usecase";

import { operationSummarySchema } from "@/schemas/operation-summary-schema";
import {
  sendSnapshot,
  successBodyOf,
  wantsFreshSnapshot,
} from "@/shared/http/snapshot-reply";

class OperationSummaryController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId } = operationSummarySchema.parse(request.query);

    const operationSummaryUseCase = container.resolve(OperationSummaryUseCase);

    // TOWER_SNAPSHOT_TTL_MS=0: the answer exactly as before the snapshot,
    // without ETag nor 304 (plano-escala F4-11).
    if (!operationSummarySnapshot.enabled) {
      const summary = await operationSummaryUseCase.execute({
        userId: id,
        businessId,
      });

      return reply.status(200).send({ data: summary });
    }

    const toBody = successBodyOf(reply);

    const read = await operationSummaryUseCase.executeSnapshot({
      userId: id,
      businessId,
      refresh: wantsFreshSnapshot(request),
      body: (summary) => toBody({ data: summary }),
    });

    return sendSnapshot(request, reply, read);
  }
}

export { OperationSummaryController };
