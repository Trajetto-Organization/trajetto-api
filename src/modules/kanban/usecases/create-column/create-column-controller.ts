import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";
import { CreateKanbanColumnUseCase } from "./create-column-usecase";
import { createKanbanColumnSchema } from "@/schemas/create-kanban-column-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

class CreateKanbanColumnController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;

    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const columnData = createKanbanColumnSchema.parse(request.body);

    const createKanbanColumnUseCase = container.resolve(
      CreateKanbanColumnUseCase,
    );

    await createKanbanColumnUseCase.execute(
      { ...columnData, businessId },
      id,
    );

    return reply.status(201).send({ message: "Coluna criada com sucesso!" });
  }
}

export { CreateKanbanColumnController };
