import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { CreateKanbanCardUseCase } from "./create-card-usecase";
import { createKanbanCardSchema } from "@/schemas/create-kanban-card-schema";

class CreateKanbanCardController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const cardData = createKanbanCardSchema.parse(request.body);

    const createKanbanCardUseCase = container.resolve(CreateKanbanCardUseCase);

    // Every refusal is an AppError with its status and code (decision 11.3):
    // an assignee of another company is ASSIGNED_USER_NOT_FOUND for a manager,
    // USER_NOT_IN_BUSINESS only for the MASTER, who sees every company.
    await createKanbanCardUseCase.execute(cardData, id);
    return reply.status(201).send({ message: "Card criado com sucesso!" });
  }
}

export { CreateKanbanCardController };
