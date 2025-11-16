import { FastifyRequest, FastifyReply } from "fastify";
import { container } from "tsyringe";

import { GetAnalyticsUseCase } from "./get-analytics-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { FleetAnalyticsNotFoundError } from "../errors/fleet-analytics-not-found-error";

import { analyticsIdSchema } from "@/schemas/analytics-id-schema";

class GetAnalyticsController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply> {
    const { id } = request.user;
    const { analyticsId } = analyticsIdSchema.parse(request.params);

    const getAnalyticsUseCase = container.resolve(GetAnalyticsUseCase);

    try {
      const result = await getAnalyticsUseCase.execute(analyticsId, id);
      return reply.status(200).send({
        analytics: result,
      });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof FleetAnalyticsNotFoundError) {
        return reply.status(404).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { GetAnalyticsController };
