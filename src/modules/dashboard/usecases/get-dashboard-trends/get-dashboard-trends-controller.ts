import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { GetDashboardTrendsUseCase } from "./get-dashboard-trends-usecase";

import { trendsPeriodSchema } from "@/schemas/trends-period-schema";
import { wantsFreshSnapshot } from "@/shared/http/snapshot-reply";

class GetDashboardTrendsController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id, entitlements } = request.user;
    const { period } = trendsPeriodSchema.parse(request.query);

    const getDashboardTrendsUseCase = container.resolve(
      GetDashboardTrendsUseCase,
    );

    const result = await getDashboardTrendsUseCase.execute({
      userId: id,
      period,
      entitlements,
      // "Atualizar" asks for numbers newer than the company's copy.
      refresh: wantsFreshSnapshot(request),
    });

    return reply.status(200).send(result);
  }
}

export { GetDashboardTrendsController };
