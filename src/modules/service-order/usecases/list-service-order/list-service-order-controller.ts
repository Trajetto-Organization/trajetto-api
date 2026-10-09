import { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { container } from "tsyringe";

import { ListServiceOrderUseCase } from "./list-service-order-usecase";
import { replyMaintenanceError } from "../errors/maintenance-http-errors";

import { listServiceOrderSchema } from "@/schemas/list-service-order-schema";
import { sendAsNDJSON } from "@/config/stream-utils";

class ListServiceOrderController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    // The route already validated AND transformed the querystring (page is a
    // number, each facet a list): re-parsing it would reject the result.
    const {
      businessId,
      page,
      pageSize,
      search,
      sort,
      order,
      status,
      maintenanceType,
      branchId,
    } = request.query as z.infer<typeof listServiceOrderSchema>;

    const listServiceOrderUseCase = container.resolve(ListServiceOrderUseCase);

    try {
      await sendAsNDJSON({
        reply,
        dataPromise: listServiceOrderUseCase
          .execute({
            userId: id,
            businessId,
            page,
            pageSize,
            search,
            sort,
            order,
            statuses: status,
            maintenanceTypes: maintenanceType,
            branchIds: branchId,
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

export { ListServiceOrderController };
