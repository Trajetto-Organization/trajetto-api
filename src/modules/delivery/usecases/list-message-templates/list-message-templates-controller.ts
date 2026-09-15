import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { z } from "zod";

import { ListMessageTemplatesUseCase } from "./list-message-templates-usecase";
import { listDeliveryMessageTemplateSchema } from "@/schemas/delivery-message-template-schema";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

class ListMessageTemplatesController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { businessId } = request.query as z.infer<
      typeof listDeliveryMessageTemplateSchema
    >;

    const useCase = container.resolve(ListMessageTemplatesUseCase);

    try {
      const result = await useCase.execute({ userId: id, businessId });

      // Plain JSON, not NDJSON: there are at most six of these, and a stream
      // over six rows is machinery around a list that fits on one screen.
      return reply.status(200).send({
        message: "Mensagens obtidas com sucesso.",
        data: result.data,
        total: result.total,
      });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { ListMessageTemplatesController };
