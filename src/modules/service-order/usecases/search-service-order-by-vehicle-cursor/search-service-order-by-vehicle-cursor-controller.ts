import { FastifyRequest, FastifyReply } from "fastify";
import { container } from "tsyringe";

import { SearchServiceOrderByVehicleCursorUseCase } from "./search-service-order-by-vehicle-cursor-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";

import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";
import { VehicleNotBelongBusinessError } from "@/modules/vehicle/usecases/errors/vehicle-not-belong-business-error";

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

      return sendAsNDJSON({
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

export { SearchServiceOrderByVehicleCursorController };
