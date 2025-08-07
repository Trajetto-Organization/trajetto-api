import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { DeleteKanbanColumnUseCase } from "./delete-column-usecase";
import { updateDeleteKanbanColumnSchema } from "@/schemas/update-delete-kanban-column-schema";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { KanbanColumnNotFoundError } from "../errors/kanban-column-not-found-error";
import { KanbanColumnNotBelongBusinessError } from "../errors/kanban-column-not-belong-business-error";

class DeleteKanbanColumnController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const { columnId, businessId } = updateDeleteKanbanColumnSchema.parse(
      request.params,
    );

    const deleteKanbanColumnUseCase = container.resolve(
      DeleteKanbanColumnUseCase,
    );

    try {
      await deleteKanbanColumnUseCase.execute(columnId, businessId, id);

      return reply
        .status(200)
        .send({ message: "Coluna deletada com sucesso!" });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof KanbanColumnNotFoundError) {
        return reply.status(404).send({ message: error.message });
      }

      if (error instanceof KanbanColumnNotBelongBusinessError) {
        return reply.status(403).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { DeleteKanbanColumnController };
