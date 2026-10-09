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
      search: query.search,
      shipperIds: query.shipperIds,
      cities: query.cities,
      ufs: query.ufs,
      kinds: query.kinds,
      scheduledFrom: query.scheduledFrom,
      scheduledTo: query.scheduledTo,
      includeUnscheduled: query.includeUnscheduled,
    });

    return reply.status(200).send({
      data: page.data,
      meta: {
        total: page.total,
        page: query.page,
        pageSize: query.pageSize,
        facets: page.facets,
      },
    });
  }
}

export { ListUnroutedDeliveriesController };
