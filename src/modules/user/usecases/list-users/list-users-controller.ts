import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";
import { z } from "zod";
import { ListUsersUseCase } from "./list-users-usecase";
import { sendAsNDJSON } from "@/config/stream-utils";
import { listUserSchema } from "@/schemas/list-user-schema";

class ListUsersController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    // The route already validated AND transformed the querystring (page is a
    // number, each facet a list): re-parsing it against the wire schema would
    // reject its own output.
    const {
      businessId,
      page,
      pageSize,
      search,
      sort,
      order,
      role,
      access,
      two_factor,
      profileAccessId,
    } = request.query as z.infer<typeof listUserSchema>;

    const listUsersUseCase = container.resolve(ListUsersUseCase);

    await sendAsNDJSON({
      reply,
      page,
      pageSize,
      dataPromise: listUsersUseCase
        .execute({
          userId: id,
          businessId,
          page,
          pageSize,
          search: search?.trim() || undefined,
          sort,
          order,
          roles: role,
          access,
          twoFactor: two_factor,
          profileAccessIds: profileAccessId,
        })
        .then((result) => ({
          data: result.data,
          total: result.total,
          meta: result.searchMeta,
        })),
    });
  }
}

export { ListUsersController };
