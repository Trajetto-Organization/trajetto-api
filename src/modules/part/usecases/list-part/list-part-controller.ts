import { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { container } from "tsyringe";

import { ListPartUseCase } from "./list-part-usecase";
import { replyMaintenanceError } from "@/modules/service-order/usecases/errors/maintenance-http-errors";

import { listPartSchema } from "@/schemas/list-part-schema";
import { sendAsNDJSON } from "@/config/stream-utils";

class ListPartController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    // Validated and transformed by the route (the facet is a list).
    const { businessId, page, pageSize, search, sort, order, supplierId } =
      request.query as z.infer<typeof listPartSchema>;

    const listPartUseCase = container.resolve(ListPartUseCase);

    try {
      await sendAsNDJSON({
        reply,
        dataPromise: listPartUseCase
          .execute({
            userId: id,
            businessId,
            page,
            pageSize,
            search,
            sort,
            order,
            supplierIds: supplierId,
          })
          .then((result) => ({
            data: result.data,
            total: result.total,
            meta: result.searchMeta,
          })),
        page,
        pageSize,
      });
    } catch (error) {
      if (replyMaintenanceError(reply, error)) return;

      throw error;
    }
  }
}

export { ListPartController };
