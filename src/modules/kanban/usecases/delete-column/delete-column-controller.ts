import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";
import { DeleteKanbanColumnUseCase } from "./delete-column-usecase";
import { updateDeleteKanbanColumnSchema } from "@/schemas/update-delete-kanban-column-schema";

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

    await deleteKanbanColumnUseCase.execute(columnId, businessId, id);
    return reply
      .status(200)
      .send({ message: "Coluna deletada com sucesso!" });
  }
}

export { DeleteKanbanColumnController };
