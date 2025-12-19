import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { DeleteKanbanCardUseCase } from "./delete-card-usecase";
import { updateDeleteKanbanCardSchema } from "@/schemas/update-delete-kanban-card-schema";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { KanbanCardColumnNotFoundError } from "../errors/kanban-card-column-not-found-error";

import { KanbanNotAllowedDeleteCardBusinessError } from "../errors/kanban-not-allowed-delete-card-business-error";
import { KanbanCardNotFoundError } from "../errors/kanban-card-not-found-error";

class DeleteKanbanCardController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const { cardId } = updateDeleteKanbanCardSchema.parse(request.params);

    const deleteKanbanCardUseCase = container.resolve(DeleteKanbanCardUseCase);

    try {
      await deleteKanbanCardUseCase.execute(cardId, id);
      return reply.status(200).send({ message: "Card deletado com sucesso!" });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof KanbanNotAllowedDeleteCardBusinessError) {
        return reply.status(403).send({ message: error.message });
      }

      if (error instanceof KanbanCardColumnNotFoundError) {
        return reply.status(404).send({ message: error.message });
      }

      if (error instanceof KanbanCardNotFoundError) {
        return reply.status(404).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { DeleteKanbanCardController };
