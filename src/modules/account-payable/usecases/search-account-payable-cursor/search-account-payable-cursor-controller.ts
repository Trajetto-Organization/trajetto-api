import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { SearchAccountPayableCursorUseCase } from "./search-account-payable-cursor-usecase";
import { cursorPaginationSchema } from "@/schemas/cursor-pagination-schema";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { sendAsNDJSON } from "@/config/stream-utils";

class SearchAccountPayableCursorController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const { id } = request.user;
      const { limit, cursor } = cursorPaginationSchema.parse(request.query);

      const searchAccountPayableCursorUseCase = container.resolve(
        SearchAccountPayableCursorUseCase,
      );

      const dataPromise = searchAccountPayableCursorUseCase.execute({
        userId: id,
        limit,
        cursor,
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

      throw error;
    }
  }
}

export { SearchAccountPayableCursorController };
