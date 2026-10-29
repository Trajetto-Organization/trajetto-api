import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { z } from "zod";

import { ListRoutesUseCase } from "./list-routes-usecase";

import { listRoutesSchema } from "@/schemas/route-schema";
import { sendAsNDJSON } from "@/config/stream-utils";

class ListRoutesController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    // Already validated AND transformed by the route's schema: the facets
    // arrive as arrays, the day as a Date.
    const {
      businessId,
      page,
      pageSize,
      sort,
      order,
      status,
      driverId,
      vehicleId,
      scheduled_date,
      search,
    } = request.query as z.infer<typeof listRoutesSchema>;

    const listRoutesUseCase = container.resolve(ListRoutesUseCase);

    // Same decoding the delivery listing does: a term typed with an accent
    // arrives percent-encoded, and a malformed sequence must not 500.
    let decodedSearch: string | undefined;

    if (search) {
      try {
        decodedSearch = decodeURIComponent(search);
      } catch {
        decodedSearch = search;
      }
    }

    const routesPromise = listRoutesUseCase.execute({
      userId: id,
      businessId,
      page,
      pageSize,
      sort,
      order,
      statuses: status,
      driverIds: driverId,
      vehicleIds: vehicleId,
      scheduled_date,
      search: decodedSearch,
    });

    await sendAsNDJSON({ reply, dataPromise: routesPromise, page, pageSize });
  }
}

export { ListRoutesController };
