import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { UpdateKanbanCardUseCase } from "./update-card-usecase";

import { updateKanbanCardSchema } from "@/schemas/update-kanban-card-schema";
import { updateDeleteKanbanCardSchema } from "@/schemas/update-delete-kanban-card-schema";

class UpdateKanbanCardController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;

    const { cardId } = updateDeleteKanbanCardSchema.parse(request.params);
    const cardData = updateKanbanCardSchema.parse(request.body);

    const updateKanbanCardUseCase = container.resolve(UpdateKanbanCardUseCase);

    // Every refusal is an AppError with its status and code (decision 11.3):
    // an assignee of another company is ASSIGNED_USER_NOT_FOUND for a manager,
    // USER_NOT_IN_BUSINESS only for the MASTER, who sees every company.
    await updateKanbanCardUseCase.execute(cardData, cardId, id);
    return reply
      .status(200)
      .send({ message: "Card atualizado com sucesso!" });
  }
}

export { UpdateKanbanCardController };
