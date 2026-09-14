import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { z } from "zod";

import { ListDeliveryUseCase } from "./list-delivery-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { listDeliverySchema } from "@/schemas/list-delivery-schema";

import { sendAsNDJSON } from "@/config/stream-utils";

class ListDeliveryController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId, page, pageSize, status, shipperId, driverId, search } =
      request.query as z.infer<typeof listDeliverySchema>;

    const listDeliveryUseCase = container.resolve(ListDeliveryUseCase);

    // Secure handling for URL decoding
    let decodedSearch: string | undefined = undefined;

    if (search) {
      try {
        decodedSearch = decodeURIComponent(search);
      } catch (error) {
        decodedSearch = search;
      }
    }

    try {
      const deliveriesPromise = listDeliveryUseCase.execute({
        userId: id,
        businessId,
        page,
        pageSize,
        status,
        shipperId,
        driverId,
        search: decodedSearch,
      });

      await sendAsNDJSON({
        reply,
        dataPromise: deliveriesPromise,
        page,
        pageSize,
      });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { ListDeliveryController };
