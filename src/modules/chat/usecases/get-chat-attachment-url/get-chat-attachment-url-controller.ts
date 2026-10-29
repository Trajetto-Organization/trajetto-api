import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";
import { z } from "zod";

import { GetChatAttachmentUrlUseCase } from "./get-chat-attachment-url-usecase";

import { getChatAttachmentUrlSchema } from "@/schemas/get-chat-attachment-url-schema";

class GetChatAttachmentUrlController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    // The route validated the querystring already; re-parsing is only to get
    // the typed value out of it.
    const { messageId, businessId } = request.query as z.infer<
      typeof getChatAttachmentUrlSchema
    >;

    const getChatAttachmentUrlUseCase = container.resolve(
      GetChatAttachmentUrlUseCase,
    );

    // ChatMessageNotFoundError is an AppError: 404 CHAT_MESSAGE_NOT_FOUND,
    // the same for a random id and for another company's message.
    const result = await getChatAttachmentUrlUseCase.execute({
      userId: id,
      messageId,
      businessId,
    });

    return reply.status(200).send(result);
  }
}

export { GetChatAttachmentUrlController };
