import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { SearchShipperCursorUseCase } from "./search-shipper-cursor-usecase";
import { cursorPaginationByBusinessSchema } from "@/schemas/cursor-pagination-schema";

import { sendAsNDJSON } from "@/config/stream-utils";

class SearchShipperCursorController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { limit, cursor, businessId, search } =
      cursorPaginationByBusinessSchema.parse(request.query);

    const searchShipperCursorUseCase = container.resolve(
      SearchShipperCursorUseCase,
    );

    const dataPromise = searchShipperCursorUseCase.execute({
      userId: id,
      limit,
      cursor,
      businessId,
      search,
    });

    // Not found (caller or company) and cross-tenant reads are AppErrors
    // with their own status and code, answered by the global handler.
    await sendAsNDJSON({
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

export { SearchShipperCursorController };
