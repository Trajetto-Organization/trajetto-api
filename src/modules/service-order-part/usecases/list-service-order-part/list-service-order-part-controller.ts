import { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { container } from "tsyringe";

import { ListServiceOrderPartUseCase } from "./list-service-order-part-usecase";
import { replyMaintenanceError } from "@/modules/service-order/usecases/errors/maintenance-http-errors";

import { listServiceOrderPartSchema } from "@/schemas/list-service-order-part-schema";
import { sendAsNDJSON } from "@/config/stream-utils";

class ListServiceOrderPartController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    // Validated and transformed by the route (each facet is a list).
    const {
      businessId,
      page,
      pageSize,
      search,
      sort,
      order,
      partId,
      serviceOrderId,
    } = request.query as z.infer<typeof listServiceOrderPartSchema>;

    const listServiceOrderPartUseCase = container.resolve(
      ListServiceOrderPartUseCase,
    );

    try {
      await sendAsNDJSON({
        reply,
        dataPromise: listServiceOrderPartUseCase
          .execute({
            userId: id,
            businessId,
            page,
            pageSize,
            search,
            sort,
            order,
            partIds: partId,
            serviceOrderIds: serviceOrderId,
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

export { ListServiceOrderPartController };
