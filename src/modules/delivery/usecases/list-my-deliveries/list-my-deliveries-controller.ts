import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { ListMyDeliveriesUseCase } from "./list-my-deliveries-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

class ListMyDeliveriesController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);

    const listMyDeliveriesUseCase = container.resolve(ListMyDeliveriesUseCase);

    try {
      const { deliveries, occurrenceTypes } =
        await listMyDeliveriesUseCase.execute({
          userId: id,
          businessId,
        });

      return reply.status(200).send({
        data: deliveries,
        occurrence_types: occurrenceTypes,
      });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { ListMyDeliveriesController };
