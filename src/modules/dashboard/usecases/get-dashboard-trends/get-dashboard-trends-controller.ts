import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { GetDashboardTrendsUseCase } from "./get-dashboard-trends-usecase";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { trendsPeriodSchema } from "@/schemas/trends-period-schema";

class GetDashboardTrendsController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    try {
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
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(404).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { GetDashboardTrendsController };
