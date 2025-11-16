import { FastifyRequest, FastifyReply } from "fastify";
import { container } from "tsyringe";

import { GenerateAnalyticsUseCase } from "./generate-analytics-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { InvalidAnalyticsTypeError } from "../errors/invalid-analytics-type-error";
import { InvalidDateRangeError } from "../errors/invalid-date-range-error";

import { generateAnalyticsSchema } from "@/schemas/generate-analytics-schema";

class GenerateAnalyticsController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply> {
    const { id } = request.user;
    const analyticsData = generateAnalyticsSchema.parse(request.body);

    const generateAnalyticsUseCase = container.resolve(
      GenerateAnalyticsUseCase,
    );

    try {
      const result = await generateAnalyticsUseCase.execute(analyticsData, id);

      return reply.status(202).send({
        message: result.message,
        analytics: result.analytics,
        status: result.status,
      });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof InvalidAnalyticsTypeError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof InvalidDateRangeError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { GenerateAnalyticsController };
