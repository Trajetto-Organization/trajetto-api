import { FastifyRequest, FastifyReply } from "fastify";
import { container } from "tsyringe";

import { SearchFuelByVehicleCursorUseCase } from "./search-fuel-by-vehicle-cursor-usecase";

import { replyFuelVehicleReadError } from "../errors/fuel-http-errors";

import { cursorPaginationSchema } from "@/schemas/cursor-pagination-schema";
import { sendAsNDJSON } from "@/config/stream-utils";
import { updateDeleteVehicleSchema } from "@/schemas/update-delete-vehicle-schema";

class SearchFuelByVehicleCursorController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const { id } = request.user;

      const { vehicleId } = updateDeleteVehicleSchema.parse(request.params);
      const { limit, cursor, search } = cursorPaginationSchema.parse(
        request.query,
      );

      const searchFuelByVehicleCursorUseCase = container.resolve(
        SearchFuelByVehicleCursorUseCase,
      );

      const dataPromise = searchFuelByVehicleCursorUseCase.execute({
        userId: id,
        vehicleId,
        limit,
        cursor,
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
      // Missing or another company's vehicle: 404 VEHICLE_NOT_FOUND, alike.
      // A driver on a vehicle they may not operate: 403
      // VEHICLE_NOT_ASSIGNED_TO_DRIVER — it used to fall through as a plain
      // Error and answer 500.
      if (replyFuelVehicleReadError(reply, error)) return;

      throw error;
    }
  }
}

export { SearchFuelByVehicleCursorController };
