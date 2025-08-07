import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { CreateKanbanColumnUseCase } from "./create-column-usecase";

import { createKanbanColumnSchema } from "@/schemas/create-kanban-column-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

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

    try {
      await createKanbanColumnUseCase.execute(
        { ...columnData, businessId },
        id,
      );

      return reply.status(201).send({ message: "Coluna criada com sucesso!" });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { CreateKanbanColumnController };
