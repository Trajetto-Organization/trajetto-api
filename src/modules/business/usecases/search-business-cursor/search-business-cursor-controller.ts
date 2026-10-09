import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { SearchBusinessCursorUseCase } from "./search-business-cursor-usecase";
import { cursorPaginationSchema } from "@/schemas/cursor-pagination-schema";

import { sendAsNDJSON } from "@/config/stream-utils";

class SearchBusinessCursorController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { limit, cursor, search } = cursorPaginationSchema.parse(
      request.query,
    );

    const searchBusinessCursorUseCase = container.resolve(
      SearchBusinessCursorUseCase,
    );

    const dataPromise = searchBusinessCursorUseCase.execute({
      userId: id,
      limit,
      cursor,
      search,
    });

    // `return await`: the stream opens only after the data resolved, so a
    // refusal (an AppError) still reaches the error handler with its code.
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

export { SearchBusinessCursorController };
