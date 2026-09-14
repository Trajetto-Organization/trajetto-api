import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { z } from "zod";

import { ListShipperUseCase } from "./list-shipper-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { listShipperSchema } from "@/schemas/list-shipper-schema";

import { sendAsNDJSON } from "@/config/stream-utils";

class ListShipperController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId, page, pageSize, search } = request.query as z.infer<
      typeof listShipperSchema
    >;

    const listShipperUseCase = container.resolve(ListShipperUseCase);

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
      const shippersPromise = listShipperUseCase.execute({
        userId: id,
        businessId,
        page,
        pageSize,
        search: decodedSearch,
      });

      await sendAsNDJSON({
        reply,
        dataPromise: shippersPromise,
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

export { ListShipperController };
