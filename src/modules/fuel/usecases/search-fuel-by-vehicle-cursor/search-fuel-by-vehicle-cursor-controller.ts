import { FastifyRequest, FastifyReply } from "fastify";
import { container } from "tsyringe";

import { SearchFuelByVehicleCursorUseCase } from "./search-fuel-by-vehicle-cursor-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";

import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";
import { VehicleNotBelongBusinessError } from "@/modules/vehicle/usecases/errors/vehicle-not-belong-business-error";

import { cursorPaginationSchema } from "@/schemas/cursor-pagination-schema";
import { sendAsNDJSON } from "@/config/stream-utils";
import { updateDeleteVehicleSchema } from "@/schemas/update-delete-vehicle-schema";

class SearchFuelByVehicleCursorController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const { id } = request.user;

      const { vehicleId } = updateDeleteVehicleSchema.parse(request.params);
      const { limit, cursor } = cursorPaginationSchema.parse(request.query);

      const searchFuelByVehicleCursorUseCase = container.resolve(
        SearchFuelByVehicleCursorUseCase,
      );

      const dataPromise = searchFuelByVehicleCursorUseCase.execute({
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
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof VehicleNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof VehicleNotBelongBusinessError) {
        return reply.status(403).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { SearchFuelByVehicleCursorController };
