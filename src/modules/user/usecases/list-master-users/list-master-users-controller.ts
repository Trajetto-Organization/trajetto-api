import { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { container } from "tsyringe";
import { ListMasterUsersUseCase } from "./list-master-users-usecase";
import { sendAsNDJSON } from "@/config/stream-utils";
import { listMasterUserSchema } from "@/schemas/list-user-schema";

class ListMasterUsersController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    // Validated and transformed by the route (facets arrive as lists).
    const { page, pageSize, search, sort, order, access, two_factor } =
      request.query as z.infer<typeof listMasterUserSchema>;

    const listMasterUsersUseCase = container.resolve(ListMasterUsersUseCase);

    await sendAsNDJSON({
      reply,
      page,
      pageSize,
      dataPromise: listMasterUsersUseCase
        .execute({
          userId: id,
          page,
          pageSize,
          search: search?.trim() || undefined,
          sort,
          order,
          access,
          twoFactor: two_factor,
        })
        .then((result) => ({
          data: result.data,
          total: result.total,
          meta: result.searchMeta,
        })),
    });
  }
}

export { ListMasterUsersController };
