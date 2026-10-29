import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { z } from "zod";

import { ListShipperUseCase } from "./list-shipper-usecase";

import { listShipperSchema } from "@/schemas/list-shipper-schema";

import { sendAsNDJSON } from "@/config/stream-utils";

class ListShipperController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    // Already validated AND transformed by the route: the Status filter
    // arrives as a list, the sort as one of the whitelisted keys.
    const { businessId, page, pageSize, search, sort, order, status } =
      request.query as z.infer<typeof listShipperSchema>;

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

    // A missing caller is an AppError (404 USER_NOT_FOUND), answered by the
    // global handler before the stream opens (decision 11.3).
    const shippersPromise = listShipperUseCase.execute({
      userId: id,
      businessId,
      page,
      pageSize,
      search: decodedSearch,
      sort,
      order,
      statuses: status,
    });

    await sendAsNDJSON({
      reply,
      dataPromise: shippersPromise,
      page,
      pageSize,
    });
  }
}

export { ListShipperController };
