import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { GetDashboardOverviewUseCase } from "./get-dashboard-overview-usecase";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

class GetDashboardOverviewController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    try {
      const { id } = request.user;

      const getDashboardOverviewUseCase = container.resolve(
        GetDashboardOverviewUseCase,
      );

      const result = await getDashboardOverviewUseCase.execute({
        userId: id,
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

export { GetDashboardOverviewController };
