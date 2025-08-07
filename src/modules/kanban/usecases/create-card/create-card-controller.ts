import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { CreateKanbanCardUseCase } from "./create-card-usecase";
import { createKanbanCardSchema } from "@/schemas/create-kanban-card-schema";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { KanbanColumnNotFoundError } from "../errors/kanban-column-not-found-error";

class CreateKanbanCardController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const cardData = createKanbanCardSchema.parse(request.body);

    const createKanbanCardUseCase = container.resolve(CreateKanbanCardUseCase);

    try {
      await createKanbanCardUseCase.execute(cardData, id);

      return reply.status(201).send({ message: "Card criado com sucesso!" });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof KanbanColumnNotFoundError) {
        return reply.status(404).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { CreateKanbanCardController };
