import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";
import { z } from "zod";
import { ListPermissionUseCase } from "./list-permission-usecase";
import { sendAsNDJSON } from "@/config/stream-utils";
import { listPermissionSchema } from "@/schemas/list-permission-schema";

class ListPermissionController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    // Validated and transformed by the route (each facet is a list).
    const {
      businessId,
      page,
      pageSize,
      search,
      sort,
      order,
      permissionKey,
      profileAccessId,
      read,
      write,
    } = request.query as z.infer<typeof listPermissionSchema>;

    const listPermissionUseCase = container.resolve(ListPermissionUseCase);

    await sendAsNDJSON({
      reply,
      page,
      pageSize,
      dataPromise: listPermissionUseCase
        .execute({
          userId: id,
          businessId,
          page,
          pageSize,
          search: search?.trim() || undefined,
          sort,
          order,
          permissionKeys: permissionKey,
          profileAccessIds: profileAccessId,
          read,
          write,
        })
        .then((result) => ({
          data: result.data,
          total: result.total,
          meta: result.searchMeta,
        })),
    });
  }
}

export { ListPermissionController };
