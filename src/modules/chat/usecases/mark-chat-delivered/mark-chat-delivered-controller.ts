import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { MarkChatDeliveredUseCase } from "./mark-chat-delivered-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { ChatThreadNotFoundError } from "../errors/chat-errors";

import { markChatDeliveredSchema } from "@/schemas/mark-chat-delivered-schema";

class MarkChatDeliveredController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId, threadId, deliveredAt } =
      markChatDeliveredSchema.parse(request.body);

    const markChatDeliveredUseCase = container.resolve(
      MarkChatDeliveredUseCase,
    );

    try {
      const { delivered_at, side } = await markChatDeliveredUseCase.execute({
        userId: id,
        threadId,
        deliveredAt: deliveredAt ? new Date(deliveredAt) : undefined,
        businessId,
      });

      return reply.status(200).send({
        message: "Entrega confirmada.",
        data: { delivered_at, side },
      });
    } catch (error) {
      if (
        error instanceof ResourceNotFoundError ||
        error instanceof ChatThreadNotFoundError
      ) {
        return reply.status(400).send({ message: error.message });
      }

      // ChatDeliveryReceiptNotAllowedError is an AppError: the global
      // handler answers it with its own 403 and error code.
      throw error;
    }
  }
}

export { MarkChatDeliveredController };
