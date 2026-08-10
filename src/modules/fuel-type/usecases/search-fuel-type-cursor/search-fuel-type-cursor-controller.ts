import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { SearchFuelTypeCursorUseCase } from "./search-fuel-type-cursor-usecase";
import { cursorPaginationByBusinessSchema } from "@/schemas/cursor-pagination-schema";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { sendAsNDJSON } from "@/config/stream-utils";

class SearchFuelTypeCursorController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const { id } = request.user;
      const { limit, cursor, businessId, search } =
        cursorPaginationByBusinessSchema.parse(request.query);

      const searchFuelTypeCursorUseCase = container.resolve(
        SearchFuelTypeCursorUseCase,
      );

      const dataPromise = searchFuelTypeCursorUseCase.execute({
        userId: id,
        limit,
        cursor,
        businessId,
        search,
      });

      return sendAsNDJSON({
        reply,
        dataPromise: dataPromise.then((result) => ({
          data: result.data,
          total: 0,
          meta: {
            nextCursor: result.nextCursor,
            hasMore: result.hasMore,
          },
        })),
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

export { SearchFuelTypeCursorController };
