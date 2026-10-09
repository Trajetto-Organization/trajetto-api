import { FastifyRequest, FastifyReply } from "fastify";
import { container } from "tsyringe";

import { SearchServiceOrderByVehicleCursorUseCase } from "./search-service-order-by-vehicle-cursor-usecase";

import { replyVehicleError } from "@/modules/vehicle/usecases/errors/vehicle-http-errors";

import { updateDeleteVehicleSchema } from "@/schemas/update-delete-vehicle-schema";
import { cursorPaginationSchema } from "@/schemas/cursor-pagination-schema";

import { sendAsNDJSON } from "@/config/stream-utils";

class SearchServiceOrderByVehicleCursorController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const { id } = request.user;

      const { vehicleId } = updateDeleteVehicleSchema.parse(request.params);
      const { limit, cursor } = cursorPaginationSchema.parse(request.query);

      const searchServiceOrderByVehicleCursorUseCase = container.resolve(
        SearchServiceOrderByVehicleCursorUseCase,
      );

      const dataPromise = searchServiceOrderByVehicleCursorUseCase.execute({
        userId: id,
        vehicleId,
        limit,
        cursor,
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
      // The vehicle routes' table, so the app reads the same answers here:
      // a colleague's vehicle is 403 VEHICLE_NOT_ASSIGNED_TO_DRIVER (it was a
      // plain Error, so it fell to the generic 500), and another company's
      // vehicle is 404 like a missing one, without confirming it exists.
      if (replyVehicleError(reply, error)) return;

      throw error;
    }
  }
}

export { SearchServiceOrderByVehicleCursorController };
