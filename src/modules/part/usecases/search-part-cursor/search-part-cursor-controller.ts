import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";
import { z } from "zod";

import { SearchPartCursorUseCase } from "./search-part-cursor-usecase";
import { cursorPaginationByBusinessSchema } from "@/schemas/cursor-pagination-schema";

import { replyMaintenanceError } from "@/modules/service-order/usecases/errors/maintenance-http-errors";

import { sendAsNDJSON } from "@/config/stream-utils";

class SearchPartCursorController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const { id } = request.user;
      const { limit, cursor, businessId, search } =
        // Validated and transformed by the route (limit is a number now):
        // parsing the result again would refuse it.
        request.query as z.infer<typeof cursorPaginationByBusinessSchema>;

      const searchPartCursorUseCase = container.resolve(
        SearchPartCursorUseCase,
      );

      const dataPromise = searchPartCursorUseCase.execute({
        userId: id,
        limit,
        cursor,
        businessId,
        search,
      });

      /**
       * `return await`, not `return`.
       *
       * A bare `return promise` inside a try/catch is not caught: an async
       * function awaits the returned promise AFTER leaving the block, so its
       * rejection walks past every `catch` below and lands in Fastify's
       * generic handler as a 500. Every branch underneath was unreachable —
       * a cross-tenant read answered "Internal server error" instead of 403,
       * and it was logged at error level, which is where real 500s go to
       * hide.
       */
      return await sendAsNDJSON({
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
      if (replyMaintenanceError(reply, error)) return;

      throw error;
    }
  }
}

export { SearchPartCursorController };
