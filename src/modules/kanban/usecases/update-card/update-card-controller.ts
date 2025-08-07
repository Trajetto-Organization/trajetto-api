import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { UpdateKanbanCardUseCase } from "./update-card-usecase";

import { updateKanbanCardSchema } from "@/schemas/update-kanban-card-schema";
import { updateDeleteKanbanCardSchema } from "@/schemas/update-delete-kanban-card-schema";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { KanbanCardNotFoundError } from "../errors/kanban-card-not-found-error";

class UpdateKanbanCardController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;

    const { cardId } = updateDeleteKanbanCardSchema.parse(request.params);
    const cardData = updateKanbanCardSchema.parse(request.body);

    const updateKanbanCardUseCase = container.resolve(UpdateKanbanCardUseCase);

    try {
      await updateKanbanCardUseCase.execute(cardData, cardId, id);

      return reply
        .status(200)
        .send({ message: "Card atualizado com sucesso!" });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof KanbanCardNotFoundError) {
        return reply.status(404).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { UpdateKanbanCardController };
