import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { SendChatMessageUseCase } from "./send-chat-message-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import {
  ChatDriverNotBelongBusinessError,
  ChatDriverNotFoundError,
} from "../errors/chat-errors";

import { DeliveryNotFoundError } from "@/modules/delivery/usecases/errors/delivery-errors";
import { sendChatMessageSchema } from "@/schemas/send-chat-message-schema";

class SendChatMessageController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const {
      driverIds,
      kind,
      body,
      attachmentKey,
      durationMs,
      deliveryId,
      clientSubmissionId,
      businessId,
    } = sendChatMessageSchema.parse(request.body);

    const sendChatMessageUseCase = container.resolve(SendChatMessageUseCase);

    try {
      const { data } = await sendChatMessageUseCase.execute({
        userId: id,
        driverIds,
        kind,
        body,
        attachmentKey,
        durationMs,
        deliveryId,
        clientSubmissionId,
        businessId,
      });

      return reply.status(201).send({
        message: "Mensagem enviada!",
        data,
      });
    } catch (error) {
      if (
        error instanceof ResourceNotFoundError ||
        error instanceof ChatDriverNotFoundError ||
        error instanceof DeliveryNotFoundError
      ) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof ChatDriverNotBelongBusinessError) {
        return reply.status(403).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { SendChatMessageController };
