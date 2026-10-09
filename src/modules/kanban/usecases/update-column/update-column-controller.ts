import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";
import { UpdateKanbanColumnUseCase } from "./update-column-usecase";
import { updateKanbanColumnSchema } from "@/schemas/update-kanban-column-schema";
import { updateDeleteKanbanColumnSchema } from "@/schemas/update-delete-kanban-column-schema";

class UpdateKanbanColumnController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const { columnId, businessId } = updateDeleteKanbanColumnSchema.parse(
      request.params,
    );
    const columnData = updateKanbanColumnSchema.parse(request.body);

    const updateKanbanColumnUseCase = container.resolve(
      UpdateKanbanColumnUseCase,
    );

    await updateKanbanColumnUseCase.execute(
      columnData,
      columnId,
      businessId,
      id,
    );

    return reply
      .status(200)
      .send({ message: "Coluna atualizada com sucesso!" });
  }
}

export { UpdateKanbanColumnController };
