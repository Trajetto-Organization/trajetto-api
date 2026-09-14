import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";
import { z } from "zod";

import { GetChatAttachmentUrlUseCase } from "./get-chat-attachment-url-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import {
  ChatMessageNotFoundError,
  ChatThreadNotFoundError,
} from "../errors/chat-errors";

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

    try {
      const result = await getChatAttachmentUrlUseCase.execute({
        userId: id,
        messageId,
        businessId,
      });

      return reply.status(200).send(result);
    } catch (error) {
      if (
        error instanceof ResourceNotFoundError ||
        error instanceof ChatMessageNotFoundError ||
        error instanceof ChatThreadNotFoundError
      ) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { GetChatAttachmentUrlController };
