import { FastifyReply, FastifyRequest } from "fastify";

import { z } from "zod";
import { container } from "tsyringe";

import { ListFuelTypeUseCase } from "./list-fuel-type-usecase";
import { listFuelTypeSchema } from "@/schemas/list-fuel-type-schema";

import { replyFuelTypeError } from "../errors/fuel-type-http-errors";
import { sendAsNDJSON } from "@/config/stream-utils";

class ListFuelTypeController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    // Validated and transformed by the route: page is already a number.
    const { page, pageSize, search, businessId, sort, order } =
      request.query as z.infer<typeof listFuelTypeSchema>;

    const listFuelTypeUseCase = container.resolve(ListFuelTypeUseCase);

    try {
      const fuelTypesPromise = listFuelTypeUseCase.execute({
        userId: id,
        businessId,
        page,
        pageSize,
        search,
        sort,
        order,
      });

      // `return await`: a bare return inside try/catch lets the rejection
      // walk past the catch below and surface as a 500.
      return await sendAsNDJSON({
        reply,
        dataPromise: fuelTypesPromise,
        page,
        pageSize,
      });
    } catch (error) {
      if (replyFuelTypeError(reply, error)) return;

      throw error;
    }
  }
}

export { ListFuelTypeController };
