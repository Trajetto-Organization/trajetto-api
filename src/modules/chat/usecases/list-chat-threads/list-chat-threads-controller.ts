import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";
import { z } from "zod";

import { ListChatThreadsUseCase } from "./list-chat-threads-usecase";
import { getOnlineUserIds } from "@/websocket";

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

    const { data, total, totalUnread } = await listChatThreadsUseCase.execute({
      userId: id,
      page,
      pageSize,
      search,
      businessId,
    });

    // Presence is transport state, so it is stitched in here — asked about
    // the drivers on THIS page only, in one read of the beats the realtime
    // processes write (plano-escala U-05: user_presence, so a process that
    // takes no sockets answers it too, and a driver whose signal dropped
    // stays online for PRESENCE_GRACE_MS). It used to fetch sockets
    // through Redis, the whole company's at first, on every GET, and the
    // unread badge refetches this list on every chat message.
    const driverUserIds = [
      ...new Set(
        data.flatMap((entry) =>
          entry.driverUser ? [entry.driverUser.id] : [],
        ),
      ),
    ];

    const onlineUserIds = new Set(
      driverUserIds.length > 0 ? await getOnlineUserIds(driverUserIds) : [],
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
  }
}

export { ListChatThreadsController };
