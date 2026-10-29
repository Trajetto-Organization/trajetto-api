import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";
import { DeleteKanbanCardUseCase } from "./delete-card-usecase";
import { updateDeleteKanbanCardSchema } from "@/schemas/update-delete-kanban-card-schema";

class DeleteKanbanCardController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const { cardId } = updateDeleteKanbanCardSchema.parse(request.params);

    const deleteKanbanCardUseCase = container.resolve(DeleteKanbanCardUseCase);

    await deleteKanbanCardUseCase.execute(cardId, id);
    return reply.status(200).send({ message: "Card deletado com sucesso!" });
  }
}

export { DeleteKanbanCardController };
