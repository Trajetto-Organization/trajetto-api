import { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { container } from "tsyringe";

import { SearchAccountPayableCursorUseCase } from "./search-account-payable-cursor-usecase";
import { cursorPaginationSchema } from "@/schemas/cursor-pagination-schema";

import { sendAsNDJSON } from "@/config/stream-utils";

class SearchAccountPayableCursorController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    // Validated AND transformed by the route (limit is a number now):
    // parsing it again against the wire schema would refuse it.
    const { limit, cursor, search } = request.query as z.infer<
      typeof cursorPaginationSchema
    >;

    const searchAccountPayableCursorUseCase = container.resolve(
      SearchAccountPayableCursorUseCase,
    );

    const dataPromise = searchAccountPayableCursorUseCase.execute({
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

export { SearchAccountPayableCursorController };
