import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";
import { ReorderKanbanCardsUseCase } from "./reorder-cards-usecase";
import { reorderKanbanCardsSchema } from "@/schemas/reorder-kanban-cards-schema";

class ReorderKanbanCardsController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const data = reorderKanbanCardsSchema.parse(request.body);

    const reorderKanbanCardsUseCase = container.resolve(
      ReorderKanbanCardsUseCase,
    );

    await reorderKanbanCardsUseCase.execute(data, id);
    return reply
      .status(200)
      .send({ message: "Cards reordenados com sucesso!" });
  }
}

export { ReorderKanbanCardsController };
