import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";
import { z } from "zod";

import { SearchVehicleTypeCursorUseCase } from "./search-vehicle-type-cursor-usecase";
import { cursorPaginationByBusinessSchema } from "@/schemas/cursor-pagination-schema";

import { sendAsNDJSON } from "@/config/stream-utils";
import { replyVehicleTypeError } from "../errors/vehicle-type-http-errors";

class SearchVehicleTypeCursorController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const { id } = request.user;
      const { limit, cursor, businessId, search } =
        // Validated and transformed by the route (`limit` is a number here);
        // parsing the transformed value again against the wire schema failed.
        request.query as z.infer<typeof cursorPaginationByBusinessSchema>;

      const searchVehicleTypeCursorUseCase = container.resolve(
        SearchVehicleTypeCursorUseCase,
      );

      const dataPromise = searchVehicleTypeCursorUseCase.execute({
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
      if (replyVehicleTypeError(reply, error)) return;

      throw error;
    }
  }
}

export { SearchVehicleTypeCursorController };
