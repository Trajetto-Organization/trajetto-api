import { FastifyReply, FastifyRequest } from "fastify";

import { z } from "zod";
import { container } from "tsyringe";

import { ListVehicleTypeUseCase } from "./list-vehicle-type-usecase";

import { listVehicleTypeSchema } from "@/schemas/list-vehicle-type-schema";
import { sendAsNDJSON } from "@/config/stream-utils";

import { replyVehicleTypeError } from "../errors/vehicle-type-http-errors";

class ListVehicleTypeController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    // Validated and transformed by the route.
    const { businessId, page, pageSize, search, sort, order } =
      request.query as z.infer<typeof listVehicleTypeSchema>;

    const listVehicleTypeUseCase = container.resolve(ListVehicleTypeUseCase);

    try {
      await sendAsNDJSON({
        reply,
        dataPromise: listVehicleTypeUseCase.execute({
          userId: id,
          businessId,
          page,
          pageSize,
          search: search?.trim() || undefined,
          sort,
          order,
        }),
        page,
        pageSize,
      });
    } catch (error) {
      if (replyVehicleTypeError(reply, error)) return;

      throw error;
    }
  }
}

export { ListVehicleTypeController };
