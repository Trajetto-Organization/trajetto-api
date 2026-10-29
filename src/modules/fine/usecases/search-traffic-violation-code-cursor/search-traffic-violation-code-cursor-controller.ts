import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { z } from "zod";

import { SearchTrafficViolationCodeCursorUseCase } from "./search-traffic-violation-code-cursor-usecase";
import { cursorPaginationSchema } from "@/schemas/cursor-pagination-schema";

import { sendAsNDJSON } from "@/config/stream-utils";

class SearchTrafficViolationCodeCursorController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    // Validated and transformed by the route: `limit` is already a number
    // and `search` trimmed (or undefined when blank).
    const { limit, cursor, search } = request.query as z.infer<
      typeof cursorPaginationSchema
    >;

    const searchTrafficViolationCodeCursorUseCase = container.resolve(
      SearchTrafficViolationCodeCursorUseCase,
    );

    const dataPromise = searchTrafficViolationCodeCursorUseCase.execute({
      userId: id,
      limit,
      cursor,
      search,
    });

    // `return await`: a bare `return promise` inside try/catch escapes the
    // catch below and lands in the generic handler as a 500.
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

export { SearchTrafficViolationCodeCursorController };
