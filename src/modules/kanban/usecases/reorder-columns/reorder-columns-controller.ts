import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";
import { ReorderKanbanColumnsUseCase } from "./reorder-columns-usecase";
import { reorderKanbanColumnsSchema } from "@/schemas/reorder-kanban-columns-schema";

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

    await reorderKanbanColumnsUseCase.execute(data, id);
    return reply
      .status(200)
      .send({ message: "Colunas reordenadas com sucesso!" });
  }
}

export { ReorderKanbanColumnsController };
