import { FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";

import { container } from "tsyringe";

import { ListFuelUseCase } from "./list-fuel-usecase";
import { replyFuelListError } from "../errors/fuel-http-errors";

import { listFuelSchema } from "@/schemas/list-fuel-schema";
import { sendAsNDJSON } from "@/config/stream-utils";

class ListFuelController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    // The route already validated AND transformed the querystring (page is a
    // number, each facet a list): re-parsing it against the wire schema
    // would reject the transformed value.
    const {
      businessId,
      page,
      pageSize,
      search,
      sort,
      order,
      branchId,
      vehicleId,
      fuelTypeId,
    } = request.query as z.infer<typeof listFuelSchema>;

    const listFuelUseCase = container.resolve(ListFuelUseCase);

    try {
      const resultPromise = listFuelUseCase
        .execute({
          userId: id,
          businessId,
          page,
          pageSize,
          search,
          sort,
          order,
          branchIds: branchId,
          vehicleIds: vehicleId,
          fuelTypeIds: fuelTypeId,
        })
        .then((result) => ({
          data: result.data,
          total: result.total,
          meta: result.searchMeta,
        }));

      // `return await`: a bare return inside try/catch lets the rejection
      // walk past the catch below and surface as a 500.
      return await sendAsNDJSON({
        reply,
        dataPromise: resultPromise,
        page,
        pageSize,
      });
    } catch (error) {
      // With a code, like the other fuel routes (decision 11.3).
      if (replyFuelListError(reply, error)) return;

      throw error;
    }
  }
}

export { ListFuelController };
