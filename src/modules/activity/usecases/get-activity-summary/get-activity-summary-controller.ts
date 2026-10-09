import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { z } from "zod";
import { GetActivitySummaryUseCase } from "./get-activity-summary-usecase";

import { activitySummarySchema } from "@/schemas/activity-summary-schema";

class GetActivitySummaryController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { period, businessId } = request.query as z.infer<
      typeof activitySummarySchema
    >;

    const getActivitySummaryUseCase = container.resolve(
      GetActivitySummaryUseCase,
    );

    const summary = await getActivitySummaryUseCase.execute({
      userId: id,
      businessId,
      periodDays: period === "30d" ? 30 : 7,
    });

    return reply.status(200).send({ data: summary });
  }
}

export { GetActivitySummaryController };
