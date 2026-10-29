import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";
import { z } from "zod";

import { SearchVehicleCursorUseCase } from "./search-vehicle-cursor-usecase";
import { cursorPaginationByBusinessSchema } from "@/schemas/cursor-pagination-schema";

import { sendAsNDJSON } from "@/config/stream-utils";

import { replyVehicleError } from "../errors/vehicle-http-errors";
import { vehiclePickerAccessOf } from "./vehicle-picker-access";

class SearchVehicleCursorController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const { id } = request.user;
      const { limit, cursor, businessId, search } =
        // Validated and transformed by the route (`limit` is a number here);
        // parsing the transformed value again against the wire schema failed.
        request.query as z.infer<typeof cursorPaginationByBusinessSchema>;

      const searchVehicleCursorUseCase = container.resolve(
        SearchVehicleCursorUseCase,
      );
      const dataPromise = searchVehicleCursorUseCase.execute({
        userId: id,
        limit,
        cursor,
        businessId,
        search,
        access: vehiclePickerAccessOf(request),
      });

      /**
       * `return await`, not `return`.
       *
       * A bare `return promise` inside a try/catch is not caught: an async
       * function awaits the returned promise AFTER leaving the block, so its
       * rejection walks past every `catch` below and lands in Fastify's
       * generic handler as a 500.
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
      if (replyVehicleError(reply, error)) return;

      throw error;
    }
  }
}

export { SearchVehicleCursorController };
