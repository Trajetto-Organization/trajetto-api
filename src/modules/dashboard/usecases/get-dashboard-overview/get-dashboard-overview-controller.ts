import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { GetDashboardOverviewUseCase } from "./get-dashboard-overview-usecase";
import { wantsFreshSnapshot } from "@/shared/http/snapshot-reply";

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
      // "Atualizar" asks for numbers newer than the company's copy.
      refresh: wantsFreshSnapshot(request),
    });

    return reply.status(200).send(result);
  }
}

export { GetDashboardOverviewController };
