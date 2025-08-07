import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { ReorderKanbanColumnsUseCase } from "./reorder-columns-usecase";
import { reorderKanbanColumnsSchema } from "@/schemas/reorder-kanban-columns-schema";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { KanbanInvalidPositionError } from "../errors/kanban-invalid-position-error";

class ReorderKanbanColumnsController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const data = reorderKanbanColumnsSchema.parse(request.body);

    const reorderKanbanColumnsUseCase = container.resolve(
      ReorderKanbanColumnsUseCase,
    );

    try {
      await reorderKanbanColumnsUseCase.execute(data, id);

      return reply
        .status(200)
        .send({ message: "Colunas reordenadas com sucesso!" });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof KanbanInvalidPositionError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { ReorderKanbanColumnsController };
