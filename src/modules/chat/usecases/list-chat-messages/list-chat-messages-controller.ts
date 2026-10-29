import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";
import { z } from "zod";

import { ListChatMessagesUseCase } from "./list-chat-messages-usecase";

import { listChatMessagesSchema } from "@/schemas/list-chat-messages-schema";

class ListChatMessagesController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    // The route already validated AND transformed the querystring (limit is
    // a number) — re-parsing the transformed value would reject it.
    const {
      threadId,
      driverId,
      beforeAt,
      beforeId,
      afterAt,
      afterId,
      aroundMessageId,
      limit,
      search,
      businessId,
      deliveryId,
      routeId,
      ticketId,
    } = request.query as z.infer<typeof listChatMessagesSchema>;

    const listChatMessagesUseCase = container.resolve(ListChatMessagesUseCase);

    // A thread of another company (404 CHAT_THREAD_NOT_FOUND, it used to be
    // a 400 with no code) and a stale or filtered-out anchor (404
    // CHAT_MESSAGE_NOT_FOUND) are AppErrors, answered by the global handler.
    const result = await listChatMessagesUseCase.execute({
      userId: id,
      threadId,
      driverId,
      before:
        beforeAt && beforeId
          ? { created_at: new Date(beforeAt), id: beforeId }
          : undefined,
      after:
        afterAt && afterId
          ? { created_at: new Date(afterAt), id: afterId }
          : undefined,
      aroundMessageId,
      limit,
      search,
      businessId,
      deliveryId,
      routeId,
      ticketId,
    });

    return reply.status(200).send(result);
  }
}

export { ListChatMessagesController };
