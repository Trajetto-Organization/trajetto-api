import { FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";

import { container } from "tsyringe";
import { ListAnalyticsBusinessUseCase } from "./list-analytics-business-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { listAnalyticsQuerySchema } from "@/schemas/list-analytics-query-schema";

import { sendAsNDJSON } from "@/config/stream-utils";

class ListAnalyticsBusinessController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { page, limit, analyticsType, period, startDate, endDate } =
      request.query as z.infer<typeof listAnalyticsQuerySchema>;

    const listAnalyticsUseCase = container.resolve(
      ListAnalyticsBusinessUseCase,
    );

    try {
      const analyticsPromise = listAnalyticsUseCase.execute(
        {
          businessId,
          page: page || 1,
          pageSize: limit || 10,
          analyticsType,
          period,
          startDate: startDate ? new Date(startDate) : undefined,
          endDate: endDate ? new Date(endDate) : undefined,
        },
        id,
      );

      await sendAsNDJSON({
        reply,
        dataPromise: analyticsPromise,
        page: page || 1,
        pageSize: limit || 10,
      });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { ListAnalyticsBusinessController };
