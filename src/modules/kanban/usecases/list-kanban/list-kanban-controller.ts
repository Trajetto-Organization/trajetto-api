import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";
import { listKanbanQuerySchema } from "@/schemas/list-kanban-query-schema";
import { ListKanbanUseCase } from "./list-kanban-usecase";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { sendAsNDJSON } from "@/config/stream-utils";

class ListKanbanController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { page, pageSize, search } = listKanbanQuerySchema.parse(
      request.query,
    );

    const listKanbanUseCase = container.resolve(ListKanbanUseCase);

    // Decode search if it exists
    let decodedSearch: string | undefined = undefined;
    if (search) {
      try {
        decodedSearch = decodeURIComponent(search);
      } catch (error) {
        decodedSearch = search;
      }
    }

    const kanban = listKanbanUseCase.execute({
      businessId,
      userId: id,
      page,
      pageSize,
      search: decodedSearch,
    });

    await sendAsNDJSON({
      reply,
      dataPromise: kanban,
      page: page || 1,
      pageSize: pageSize || 10,
    });
  }
}

export { ListKanbanController };
