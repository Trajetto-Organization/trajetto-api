import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { MarkChatReadUseCase } from "./mark-chat-read-usecase";

import { markChatReadSchema } from "@/schemas/mark-chat-read-schema";

class MarkChatReadController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { threadId, businessId, readAt } = markChatReadSchema.parse(
      request.body,
    );

    const markChatReadUseCase = container.resolve(MarkChatReadUseCase);

    // ChatThreadNotFoundError is an AppError: 404 CHAT_THREAD_NOT_FOUND.
    const { last_read_at } = await markChatReadUseCase.execute({
      userId: id,
      threadId,
      businessId,
      readAt: readAt ? new Date(readAt) : undefined,
    });

    return reply.status(200).send({
      message: "Conversa marcada como lida.",
      data: { last_read_at },
    });
  }
}

export { MarkChatReadController };
