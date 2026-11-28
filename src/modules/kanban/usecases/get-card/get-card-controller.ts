import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";
import { z } from "zod";

import { GetKanbanCardUseCase } from "./get-card-usecase";

import { updateDeleteKanbanCardSchema } from "@/schemas/update-delete-kanban-card-schema";
import { optionalCompanyQuerySchema } from "@/schemas/selected-company-query-schema";

class GetKanbanCardController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { cardId } = updateDeleteKanbanCardSchema.parse(request.params);
    // Validated by the route.
    const { businessId } = request.query as z.infer<
      typeof optionalCompanyQuerySchema
    >;

    const getKanbanCardUseCase = container.resolve(GetKanbanCardUseCase);

    const card = await getKanbanCardUseCase.execute({
      userId: id,
      cardId,
      businessId,
    });

    return reply.status(200).send({ card });
  }
}

export { GetKanbanCardController };
