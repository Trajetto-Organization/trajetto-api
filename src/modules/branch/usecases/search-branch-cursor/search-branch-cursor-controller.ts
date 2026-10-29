import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";
import { z } from "zod";

import { SearchBranchCursorUseCase } from "./search-branch-cursor-usecase";
import { cursorPaginationByBusinessSchema } from "@/schemas/cursor-pagination-schema";

import { sendAsNDJSON } from "@/config/stream-utils";

class SearchBranchCursorController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    // The route already validated AND transformed the querystring (limit
    // is a number): re-parsing it would refuse it.
    const { limit, cursor, businessId, search } = request.query as z.infer<
      typeof cursorPaginationByBusinessSchema
    >;

    const searchBranchCursorUseCase = container.resolve(
      SearchBranchCursorUseCase,
    );

    const dataPromise = searchBranchCursorUseCase.execute({
      userId: id,
      limit,
      cursor,
      businessId,
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

export { SearchBranchCursorController };
