import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { MarkChatDeliveredUseCase } from "./mark-chat-delivered-usecase";

import { markChatDeliveredSchema } from "@/schemas/mark-chat-delivered-schema";

class MarkChatDeliveredController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId, threadId, deliveredAt } = markChatDeliveredSchema.parse(
      request.body,
    );

    const markChatDeliveredUseCase = container.resolve(
      MarkChatDeliveredUseCase,
    );

    // ChatThreadNotFoundError (404) and ChatDeliveryReceiptNotAllowedError
    // (403) are AppErrors: the global handler answers each with its code.
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
  }
}

export { MarkChatDeliveredController };
