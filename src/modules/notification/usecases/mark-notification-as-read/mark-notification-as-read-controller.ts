import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { MarkNotificationAsReadUseCase } from "./mark-notification-as-read-usecase";

import { updateDeleteUserNotificationSchema } from "@/schemas/delete-user-notification-schema";

class MarkNotificationAsReadController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const { notificationId } = updateDeleteUserNotificationSchema.parse(
      request.params,
    );

    const markNotificationAsReadUseCase = container.resolve(
      MarkNotificationAsReadUseCase,
    );

    const notification = await markNotificationAsReadUseCase.execute({
      notificationId,
      userId: id,
    });

    return reply.status(200).send({
      message: "Notificação marcada como lida!",
      notification,
    });
  }
}

export { MarkNotificationAsReadController };
