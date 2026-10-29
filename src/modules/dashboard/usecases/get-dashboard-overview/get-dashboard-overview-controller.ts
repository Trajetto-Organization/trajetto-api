import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { GetDashboardOverviewUseCase } from "./get-dashboard-overview-usecase";

class GetDashboardOverviewController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id, entitlements } = request.user;

    const getDashboardOverviewUseCase = container.resolve(
      GetDashboardOverviewUseCase,
    );

    const result = await getDashboardOverviewUseCase.execute({
      userId: id,
      entitlements,
    });

    return reply.status(200).send(result);
  }
}

export { GetDashboardOverviewController };
