import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { SearchBranchCursorUseCase } from "./search-branch-cursor-usecase";
import { cursorPaginationByBusinessSchema } from "@/schemas/cursor-pagination-schema";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { sendAsNDJSON } from "@/config/stream-utils";

class SearchBranchCursorController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const { id } = request.user;
      const { limit, cursor, businessId } =
        cursorPaginationByBusinessSchema.parse(request.query);

      const searchBranchCursorUseCase = container.resolve(
        SearchBranchCursorUseCase,
      );

      const dataPromise = searchBranchCursorUseCase.execute({
        userId: id,
        limit,
        cursor,
        businessId,
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

export { SearchBranchCursorController };
