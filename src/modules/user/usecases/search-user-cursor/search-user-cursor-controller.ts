import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";
import { SearchUserCursorUseCase } from "./search-user-cursor-usecase";
import { cursorPaginationByBusinessSchema } from "@/schemas/cursor-pagination-schema";
import { sendAsNDJSON } from "@/config/stream-utils";
import { z } from "zod";

class SearchUserCursorController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    // Validated AND transformed by the route (limit is a number now):
    // parsing it again against the wire schema would reject its output.
    const { limit, cursor, businessId, search } =
      request.query as z.infer<typeof cursorPaginationByBusinessSchema>;

    const searchUserCursorUseCase = container.resolve(
      SearchUserCursorUseCase,
    );

    const dataPromise = searchUserCursorUseCase.execute({
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
  }
}

export { SearchUserCursorController };
