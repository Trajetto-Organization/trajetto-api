import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { ListMyDeliveriesUseCase } from "./list-my-deliveries-usecase";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

class ListMyDeliveriesController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);

    const listMyDeliveriesUseCase = container.resolve(ListMyDeliveriesUseCase);

    const {
      deliveries,
      routes,
      occurrenceTypes,
      deliveredTypes,
      pauseTypes,
      journey,
    } = await listMyDeliveriesUseCase.execute({
      userId: id,
      businessId,
    });

    return reply.status(200).send({
      data: deliveries,
      routes,
      occurrence_types: occurrenceTypes,
      delivered_types: deliveredTypes,
      pause_types: pauseTypes,
      journey,
    });
  }
}

export { ListMyDeliveriesController };
