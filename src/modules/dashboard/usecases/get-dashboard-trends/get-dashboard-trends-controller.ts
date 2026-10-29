import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { GetDashboardTrendsUseCase } from "./get-dashboard-trends-usecase";

import { trendsPeriodSchema } from "@/schemas/trends-period-schema";

class GetDashboardTrendsController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const { period } = trendsPeriodSchema.parse(request.query);

    const getDashboardTrendsUseCase = container.resolve(
      GetDashboardTrendsUseCase,
    );

    const result = await getDashboardTrendsUseCase.execute({
      userId: id,
      period,
    });

    return reply.status(200).send(result);
  }
}

export { GetDashboardTrendsController };
