import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";
import { z } from "zod";

import { ListChatMessagesUseCase } from "./list-chat-messages-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { ChatThreadNotFoundError } from "../errors/chat-errors";

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
    } = request.query as z.infer<typeof listChatMessagesSchema>;

    const listChatMessagesUseCase = container.resolve(ListChatMessagesUseCase);

    try {
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
      });

      return reply.status(200).send(result);
    } catch (error) {
      if (
        error instanceof ResourceNotFoundError ||
        error instanceof ChatThreadNotFoundError
      ) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { ListChatMessagesController };
