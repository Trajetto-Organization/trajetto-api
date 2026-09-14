import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";
import { z } from "zod";

import { ListChatThreadsUseCase } from "./list-chat-threads-usecase";
import { getOnlineUserIdsForBusiness } from "@/websocket";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { listChatThreadsSchema } from "@/schemas/list-chat-threads-schema";

class ListChatThreadsController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    // The route already validated AND transformed the querystring (page is
    // a number) — re-parsing the transformed value would reject it.
    const { page, pageSize, search, businessId } = request.query as z.infer<
      typeof listChatThreadsSchema
    >;

    const listChatThreadsUseCase = container.resolve(ListChatThreadsUseCase);

    try {
      const {
        data,
        total,
        totalUnread,
        businessId: resolvedBusinessId,
      } = await listChatThreadsUseCase.execute({
        userId: id,
        page,
        pageSize,
        search,
        businessId,
      });

      // Presence is transport state, so it is stitched in here: one
      // cluster-wide adapter roundtrip answers for the whole page.
      const onlineUserIds = new Set(
        await getOnlineUserIdsForBusiness(resolvedBusinessId),
      );

      return reply.status(200).send({
        data: data.map((entry) => ({
          ...entry,
          driverUser: entry.driverUser
            ? {
                ...entry.driverUser,
                online: onlineUserIds.has(entry.driverUser.id),
              }
            : null,
        })),
        total,
        totalUnread,
      });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { ListChatThreadsController };
