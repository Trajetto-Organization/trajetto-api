import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { SendChatMessageUseCase } from "./send-chat-message-usecase";

import { sendChatMessageSchema } from "@/schemas/send-chat-message-schema";
import { idempotencyKeyOf } from "@/shared/http/idempotency-key";

class SendChatMessageController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const {
      driverIds,
      audience,
      kind,
      body,
      attachmentKey,
      durationMs,
      deliveryId,
      routeId,
      clientSubmissionId,
      businessId,
      ticketId,
    } = sendChatMessageSchema.parse(request.body);

    const sendChatMessageUseCase = container.resolve(SendChatMessageUseCase);

    // The chat's not-found answers (driver, delivery, route) are AppErrors:
    // the global handler sends each one's 404 with its code.
    const { data, outcomes, summary } = await sendChatMessageUseCase.execute({
      userId: id,
      driverIds,
      audience,
      kind,
      body,
      attachmentKey,
      durationMs,
      deliveryId,
      routeId,
      clientSubmissionId,
      businessId,
      // The header keys a mass notice per driver, and a single send that
      // carries no body key (see broadcastKey).
      broadcastKey: idempotencyKeyOf(request.headers),
      ticketId,
    });

    return reply.status(201).send({
      message: "Mensagem enviada!",
      data,
      outcomes,
      summary,
    });
  }
}

export { SendChatMessageController };
