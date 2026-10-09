import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { z } from "zod";

import { ListDeliveryUseCase } from "./list-delivery-usecase";

import { listDeliverySchema } from "@/schemas/list-delivery-schema";

import { sendAsNDJSON } from "@/config/stream-utils";

class ListDeliveryController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    // The route already validated AND transformed the querystring (page is a
    // number, each facet a list): re-parsing it would reject the lists.
    const {
      businessId,
      page,
      pageSize,
      search,
      sort,
      order,
      status,
      shipperId,
      driverId,
    } = request.query as z.infer<typeof listDeliverySchema>;

    const listDeliveryUseCase = container.resolve(ListDeliveryUseCase);

    const deliveriesPromise = listDeliveryUseCase.execute({
      userId: id,
      businessId,
      page,
      pageSize,
      search,
      sort,
      order,
      statuses: status,
      shipperIds: shipperId,
      driverIds: driverId,
    });

    await sendAsNDJSON({
      reply,
      dataPromise: deliveriesPromise,
      page,
      pageSize,
    });
  }
}

export { ListDeliveryController };
