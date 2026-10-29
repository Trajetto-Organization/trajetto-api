import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { ListOpenStopsUseCase } from "./open-stops-usecase";

import { openStopsQuerySchema } from "@/schemas/route-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

class ListOpenStopsController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { deliveryIds } = openStopsQuerySchema.parse(request.query);

    const useCase = container.resolve(ListOpenStopsUseCase);

    const data = await useCase.execute({
      userId: id,
      businessId,
      deliveryIds: deliveryIds ?? [],
    });

    return reply.status(200).send({ data });
  }
}

export { ListOpenStopsController };
