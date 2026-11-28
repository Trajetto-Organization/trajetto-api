import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { ListUnroutedDeliveriesUseCase } from "./list-unrouted-deliveries-usecase";

import { listUnroutedDeliveriesSchema } from "@/schemas/route-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

class ListUnroutedDeliveriesController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const query = listUnroutedDeliveriesSchema.parse(request.query);

    const useCase = container.resolve(ListUnroutedDeliveriesUseCase);

    const page = await useCase.execute({
      userId: id,
      businessId,
      page: query.page,
      pageSize: query.pageSize,
      cursor: query.cursor,
      search: query.search,
      shipperIds: query.shipperIds,
      cities: query.cities,
      ufs: query.ufs,
      kinds: query.kinds,
      scheduledFrom: query.scheduledFrom,
      scheduledTo: query.scheduledTo,
      includeUnscheduled: query.includeUnscheduled,
    });

    // total and facets only on a first page: a cursor page keeps the first
    // one's (G9).
    return reply.status(200).send({
      data: page.data,
      meta: {
        ...(page.total !== undefined && { total: page.total }),
        page: query.page,
        pageSize: query.pageSize,
        ...(page.facets && { facets: page.facets }),
        nextCursor: page.nextCursor,
      },
    });
  }
}

export { ListUnroutedDeliveriesController };
