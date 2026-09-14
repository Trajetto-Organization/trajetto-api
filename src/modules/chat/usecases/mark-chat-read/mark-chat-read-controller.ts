import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { MarkChatReadUseCase } from "./mark-chat-read-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { ChatThreadNotFoundError } from "../errors/chat-errors";

import { markChatReadSchema } from "@/schemas/mark-chat-read-schema";

class MarkChatReadController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { threadId, businessId, readAt } = markChatReadSchema.parse(
      request.body,
    );

    const markChatReadUseCase = container.resolve(MarkChatReadUseCase);

    try {
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

export { MarkChatReadController };
